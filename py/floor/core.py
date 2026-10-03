"""Motor da mesa: transforma os dados dos bots em robôs, aplica o teto de drawdown e a kill-line."""
import json
import os
import random
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from .employees import ROLES, EmployeeError

MAX_EVENTS = 60
MAX_HISTORY_POINTS = 600


def now_ms():
    return int(time.time() * 1000)


def iso(ms):
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat()


def parse_ms(value):
    """Aceita epoch (ms ou s) ou data ISO; data sem fuso é tratada como UTC, como no Freqtrade."""
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return int(value if value > 1e11 else value * 1000)
    text = str(value).strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        dt = datetime.strptime(text, "%Y-%m-%d %H:%M:%S")
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def trade_pnl(trade):
    value = trade.get("profit_abs")
    if value is None:
        value = trade.get("close_profit_abs")
    return float(value or 0.0)


def trade_open_ms(trade):
    return trade.get("open_timestamp") or parse_ms(trade.get("open_date"))


def trade_close_ms(trade):
    return trade.get("close_timestamp") or parse_ms(trade.get("close_date"))


def fmt_money(value):
    return f"{value:+,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")


def robot_matches(robot, trade, since_ms=None):
    if robot.get("pair") and trade.get("pair") != robot["pair"]:
        return False
    if robot.get("strategy") and trade.get("strategy") != robot["strategy"]:
        return False
    if since_ms and (trade_open_ms(trade) or 0) < since_ms:
        return False
    return True


def local_midnight_ms(ts):
    day = datetime.fromtimestamp(ts / 1000).astimezone().replace(hour=0, minute=0, second=0, microsecond=0)
    return int(day.timestamp() * 1000)


def downsample(points, limit):
    if len(points) <= limit:
        return points
    step = len(points) / (limit - 1)
    sampled = [points[int(i * step)] for i in range(limit - 1)]
    sampled.append(points[-1])
    return sampled


def empty_state():
    return {"rev": None, "ejected": {}, "peaks": {}, "reset": {}, "events": [], "killed": None, "alerts": {}}


class CommandError(ValueError):
    """Ordem recusada, com mensagem pronta para mostrar na tela."""


def read_state(path):
    state = empty_state()
    try:
        state.update(json.loads(Path(path).read_text(encoding="utf-8")))
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    return state


def write_state(path, state):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, path)


class FloorEngine:
    def __init__(self, config, sources, robots, state_path, employees=None, notifier=None):
        self.config = config
        self.notifier = notifier
        self.sources = sources
        self.base_robots = robots
        self.employees = employees
        self.robot_by_id = {robot["id"]: robot for robot in self.robots}
        self.state_path = Path(state_path)
        self.state = self._load_state()
        self.snapshot = None
        self.lock = threading.Lock()          # protege o snapshot lido pelo servidor HTTP
        self.tick_lock = threading.RLock()    # uma leitura ou ordem por vez
        self._prev = {}
        self._last_bots = {}
        self._prices = {}
        self._bot_online = {}

    @property
    def robots(self):
        """Robôs do config (com pausa/função ajustadas pela tela) mais os funcionários contratados."""
        if not self.employees:
            return list(self.base_robots)
        return [self.employees.apply(r) for r in self.base_robots] + self.employees.employees()

    # ---------- estado persistido (ejeções sobrevivem a reinícios) ----------

    def _load_state(self):
        return read_state(self.state_path)

    def _save_state(self):
        write_state(self.state_path, self.state)

    # ---------- ciclo de leitura ----------

    def tick(self, ts=None):
        with self.tick_lock:
            return self._tick(ts or now_ms())

    def _tick(self, ts):
        on_disk = read_state(self.state_path)
        if on_disk["rev"] != self.state["rev"]:  # o comando `reinstate` mexeu no arquivo
            self.state = on_disk
        self.state.setdefault("alerts", {})
        robots = self.robots
        self.robot_by_id = {robot["id"]: robot for robot in robots}

        bots = {}
        for name, source in self.sources.items():
            data = source.fetch()
            if data.get("online"):
                self._last_bots[name] = data
            elif name in self._last_bots:  # mantém os últimos números, marcados como offline
                data = {**self._last_bots[name], "online": False, "error": data.get("error")}
            bots[name] = data
            if hasattr(source, "prices"):
                pairs = sorted({r["pair"] for r in robots if r["bot"] == name and r.get("pair")})
                try:
                    self._prices.update(source.prices(pairs))
                except Exception:  # sem cotação nesta leitura; os números da conta continuam valendo
                    pass

        views = [self._robot_view(robot, bots.get(robot["bot"])) for robot in robots]
        portfolio = self._portfolio(bots, ts)
        self._apply_limits(views, portfolio, ts)
        self._check_price_alerts(views, ts)
        self._emit_transitions(views, ts)
        self._notify_bots(bots)
        self._notify_trades(bots, robots, portfolio, ts)
        self._save_state()

        snapshot = self._build_snapshot(views, portfolio, bots, ts)
        with self.lock:
            self.snapshot = snapshot
        return snapshot

    def _robot_view(self, robot, bot):
        rid = robot["id"]
        view = {
            "id": rid,
            "name": robot.get("name", rid),
            "bot": robot["bot"],
            "pair": robot.get("pair"),
            "strategy": robot.get("strategy") or (bot or {}).get("strategy"),
            "max_drawdown": robot.get("max_drawdown"),
            "state": "offline",
            "open_pnl": 0.0,
            "open_stake": 0.0,
            "realized_pnl": 0.0,
            "total_pnl": 0.0,
            "peak_pnl": 0.0,
            "drawdown": 0.0,
            "drawdown_used": None,
            "trades": 0,
            "wins": 0,
            "open_trades": [],
            "ejected": None,
            "error": None,
            "role": robot.get("role", "auto"),
            "paused": bool(robot.get("paused")),
            "employee": bool(robot.get("employee")),
            "stake": robot.get("stake"),
            "alert_above": robot.get("alert_above"),
            "alert_below": robot.get("alert_below"),
            "price": self._prices.get(robot.get("pair")),
        }
        if bot is None:
            view["error"] = f"bot {robot['bot']!r} não configurado"
            return view

        since = max(filter(None, [parse_ms(robot.get("since")), self.state["reset"].get(rid)]), default=None)
        opened = [t for t in bot.get("open_trades", []) if robot_matches(robot, t, since)]
        closed = sorted(
            (t for t in bot.get("closed_trades", []) if robot_matches(robot, t, since)),
            key=lambda t: trade_close_ms(t) or 0,
        )

        realized = 0.0
        peak = max(0.0, self.state["peaks"].get(rid, 0.0))
        for trade in closed:
            realized += trade_pnl(trade)
            peak = max(peak, realized)
        open_pnl = sum(trade_pnl(t) for t in opened)
        total = realized + open_pnl
        peak = max(peak, total)
        self.state["peaks"][rid] = peak
        drawdown = peak - total

        view.update(
            open_pnl=round(open_pnl, 4),
            open_stake=round(sum(float(t.get("stake_amount") or 0) for t in opened), 4),
            realized_pnl=round(realized, 4),
            total_pnl=round(total, 4),
            peak_pnl=round(peak, 4),
            drawdown=round(drawdown, 4),
            drawdown_used=round(drawdown / view["max_drawdown"], 4) if view["max_drawdown"] else None,
            trades=len(closed),
            wins=sum(1 for t in closed if trade_pnl(t) > 0),
            open_trades=[
                {
                    "id": t.get("trade_id"),
                    "pair": t.get("pair"),
                    "side": "short" if t.get("is_short") else "long",
                    "open_rate": t.get("open_rate"),
                    "current_rate": t.get("current_rate"),
                    "stake": t.get("stake_amount"),
                    "pnl": round(trade_pnl(t), 4),
                    "ratio": float(t.get("profit_ratio") or 0),
                    "opened_at": trade_open_ms(t),
                }
                for t in opened
            ],
            error=bot.get("error"),
        )
        if bot.get("online"):
            if opened:
                view["state"] = "operating"
            elif view["role"] == "watch":
                view["state"] = "watching"
            elif view["paused"]:
                view["state"] = "paused"
            else:
                view["state"] = "idle"
        if rid in self.state["ejected"]:
            view["state"] = "ejected"
            view["ejected"] = self.state["ejected"][rid]
        return view

    def _portfolio(self, bots, ts):
        pcfg = self.config["portfolio"]
        start = float(pcfg.get("starting_capital") or 0)
        closed = sorted(
            (t for bot in bots.values() for t in bot.get("closed_trades", [])),
            key=lambda t: trade_close_ms(t) or 0,
        )
        opened = [t for bot in bots.values() for t in bot.get("open_trades", [])]
        realized = sum(trade_pnl(t) for t in closed)
        open_pnl = sum(trade_pnl(t) for t in opened)
        total = realized + open_pnl
        midnight = local_midnight_ms(ts)

        history, equity = [], start
        if closed:
            history.append([trade_open_ms(closed[0]) or trade_close_ms(closed[0]), round(start, 4)])
        for trade in closed:
            equity += trade_pnl(trade)
            history.append([trade_close_ms(trade), round(equity, 4)])
        history = downsample(history, MAX_HISTORY_POINTS)
        history.append([ts, round(start + total, 4)])

        kill_line = pcfg.get("kill_line")
        return {
            "starting_capital": start,
            "equity": round(start + total, 4),
            "realized_pnl": round(realized, 4),
            "open_pnl": round(open_pnl, 4),
            "total_pnl": round(total, 4),
            "today_pnl": round(sum(trade_pnl(t) for t in closed if (trade_close_ms(t) or 0) >= midnight), 4),
            "trades": len(closed),
            "wins": sum(1 for t in closed if trade_pnl(t) > 0),
            "kill_line": kill_line,
            "kill_line_used": round(max(0.0, -total) / kill_line, 4) if kill_line else None,
            "killed": self.state["killed"],
            "history": history,
        }

    # ---------- regras de saída: teto por robô e kill-line da carteira ----------

    def _apply_limits(self, views, portfolio, ts):
        kill_line = portfolio["kill_line"]
        if kill_line and portfolio["total_pnl"] <= -kill_line and not self.state["killed"]:
            self.state["killed"] = {"at": ts, "total_pnl": portfolio["total_pnl"]}
            portfolio["killed"] = self.state["killed"]
            reason = f"kill-line da carteira ({fmt_money(portfolio['total_pnl'])} {self.config['currency']})"
            for view in views:
                if view["state"] != "ejected":
                    self._eject(view, reason, ts, enforce=False)
            note = self._enforce_kill()
            self._event(ts, "kill", None, f"KILL-LINE atingida: carteira desligada. {note}".strip())
            return

        for view in views:
            if view["state"] in ("ejected", "offline") or not view["max_drawdown"]:
                continue
            if view["drawdown"] >= view["max_drawdown"]:
                reason = f"drawdown {view['drawdown']:.2f} ≥ teto {view['max_drawdown']:.2f}".replace(".", ",")
                self._eject(view, reason, ts, enforce=True)

    def _eject(self, view, reason, ts, enforce):
        note = self._enforce_robot(view) if enforce else ""
        record = {"at": ts, "reason": reason, "total_pnl": view["total_pnl"], "enforced": note}
        self.state["ejected"][view["id"]] = record
        view["state"] = "ejected"
        view["ejected"] = record
        self._event(ts, "eject", view["id"], f"{view['name']} ejetado: {reason}. {note}".strip())

    def _enforce_robot(self, view):
        if not self.config.get("enforce"):
            return "Ejeção só visual (enforce desligado)."
        robot = self.robot_by_id[view["id"]]
        try:
            return " ".join(self.sources[robot["bot"]].eject_robot(robot, [t["id"] for t in view["open_trades"]]))
        except Exception as exc:  # o bot pode estar fora do ar; a ejeção visual vale mesmo assim
            return f"Falha ao aplicar no bot: {exc}"

    def _enforce_kill(self):
        if not self.config.get("enforce"):
            return "Ejeção só visual (enforce desligado)."
        notes = []
        for name, source in self.sources.items():
            try:
                notes.extend(source.kill_all())
            except Exception as exc:
                notes.append(f"Falha no bot {name}: {exc}")
        return " ".join(notes)

    # ---------- eventos para o painel ----------

    def _event(self, ts, kind, robot_id, text, **extra):
        self.state["events"].insert(0, {"ts": ts, "type": kind, "robot": robot_id, "text": text, **extra})
        del self.state["events"][MAX_EVENTS:]
        if kind in self.PUSH_EVENTS:
            title, priority, tag = self.PUSH_EVENTS[kind]
            self._push(title, text, priority, tag)

    def _emit_transitions(self, views, ts):
        currency = self.config["currency"]
        for view in views:
            prev = self._prev.get(view["id"])
            self._prev[view["id"]] = (view["state"], view["realized_pnl"])
            if not prev or prev[0] == view["state"]:
                continue
            before, realized_before = prev
            name, state = view["name"], view["state"]
            waiting = ("idle", "watching", "paused")
            if state == "operating" and before in waiting:
                pairs = ", ".join(sorted({t["pair"] for t in view["open_trades"]}))
                self._event(ts, "open", view["id"], f"{name} sentou na mesa: abriu {pairs}")
            elif state in waiting and before == "operating":
                result = view["realized_pnl"] - realized_before
                self._event(ts, "close", view["id"], f"{name} zerou: {fmt_money(result)} {currency}", pnl=round(result, 4))
            elif state == "offline":
                self._event(ts, "offline", view["id"], f"{name} sem dados (bot {view['bot']} offline)")
            elif before == "offline" and state in ("operating", *waiting):
                self._event(ts, "online", view["id"], f"{name} voltou a responder")

    # ---------- avisos no celular ----------

    # eventos do painel que também viram aviso: (título, prioridade de 1 a 5, ícone do ntfy)
    PUSH_EVENTS = {
        "kill": ("LIMITE DA CARTEIRA ATINGIDO: tudo parado", 5, "rotating_light"),
        "eject": ("Robô ejetado pelo limite de perda", 5, "warning"),
        "alert": ("Alerta de preço", 4, "bell"),
    }

    def _push(self, title, message, priority=3, tag=None):
        if self.notifier and self.notifier.enabled:
            self.notifier.send(title, message, [tag] if tag else [], priority)

    def _notify_bots(self, bots):
        """Avisa quando um bot para de responder e quando volta (robôs parados não vigiam o stop)."""
        for name, bot in bots.items():
            online, before = bool(bot.get("online")), self._bot_online.get(name)
            self._bot_online[name] = online
            if before is None or before == online:
                continue
            if online:
                self._push(f"Bot {name} voltou a funcionar", "Os robôs dele voltaram a operar e a vigiar o stop.", 3, "white_check_mark")
            else:
                error = str(bot.get("error") or "")
                if "10061" in error or "refused" in error.lower():
                    reason = "o programa do bot está desligado"
                elif "401" in error or "senha" in error:
                    reason = "a senha da mesa não confere com a do bot"
                else:
                    reason = "sem conexão com o bot"
                self._push(f"Bot {name} parou de responder",
                           f"Motivo: {reason}. Enquanto ele estiver fora, os robôs dele não operam nem vigiam o stop.",
                           4, "x")

    def _notify_trades(self, bots, robots, portfolio, ts):
        """Avisa cada compra executada e cada venda (com lucro ou perda). Guarda as já avisadas (7 dias)
        para não repetir depois de um reinício; o que aconteceu antes de ligar os avisos não é avisado."""
        if not (self.notifier and self.notifier.enabled):
            return
        sent = self.state.setdefault("notified", {"since": ts, "trades": {}})
        sent["since"] = max(sent["since"], ts - 7 * 24 * 3600 * 1000)
        sent["trades"] = {k: v for k, v in sent["trades"].items() if v >= sent["since"]}
        currency = self.config["currency"]
        for name, bot in bots.items():
            if not bot.get("online"):
                continue
            footer = " (simulação, dinheiro fictício)" if bot.get("dry_run", True) else ""

            def who(trade):
                robot = next((r for r in robots if r["bot"] == name and robot_matches(r, trade)), None)
                return robot["name"] if robot else name

            for trade in bot.get("open_trades", []):
                # compra ainda pendente (amount 0) só é avisada quando for executada
                key, opened_at = f"open:{name}:{trade.get('trade_id')}", trade_open_ms(trade) or 0
                if key in sent["trades"] or opened_at < sent["since"] or not float(trade.get("amount") or 0):
                    continue
                sent["trades"][key] = opened_at
                stake = float(trade.get("stake_amount") or 0)
                self._push(f"{who(trade)} comprou {trade.get('pair')}",
                           f"{fmt_money(stake)[1:]} {currency} a {fmt_money(float(trade.get('open_rate') or 0))[1:]}.{footer}",
                           3, "shopping_cart")

            for trade in bot.get("closed_trades", []):
                key, closed_at = f"close:{name}:{trade.get('trade_id')}", trade_close_ms(trade) or 0
                if key in sent["trades"] or closed_at < sent["since"]:
                    continue
                sent["trades"][key] = closed_at
                pnl = trade_pnl(trade)
                if pnl <= 0 and self.notifier.only_gains:
                    continue
                verb, tag = ("lucrou", "moneybag") if pnl > 0 else ("perdeu", "chart_with_downwards_trend")
                ratio = float(trade.get("profit_ratio") or trade.get("close_profit") or 0)
                self._push(f"{who(trade)} {verb} {fmt_money(pnl)} {currency}",
                           f"Vendeu {trade.get('pair')} com {ratio:+.2%}".replace(".", ",")
                           + f". Carteira: {fmt_money(portfolio['equity'])[1:]} {currency}.{footer}", 3, tag)

    def _check_price_alerts(self, views, ts):
        """Vigias avisam uma vez quando o preço cruza o valor; rearmam quando o preço volta."""
        for view in views:
            price = view["price"]
            if view["role"] != "watch" or price is None or view["state"] == "ejected":
                continue
            fired = self.state["alerts"].setdefault(view["id"], {"above": False, "below": False})
            for side, limit, crossed in (("above", view["alert_above"], lambda p, x: p >= x),
                                         ("below", view["alert_below"], lambda p, x: p <= x)):
                if not limit:
                    continue
                if crossed(price, limit) and not fired[side]:
                    fired[side] = True
                    word = "subiu acima de" if side == "above" else "caiu abaixo de"
                    self._event(ts, "alert", view["id"],
                                f"{view['name']} avisa: {view['pair']} {word} {limit:,.2f} (agora {price:,.2f})")
                elif not crossed(price, limit):
                    fired[side] = False

    def simulate_gain(self, robot_id=None):
        """Teste da reação de ganho: cria só o evento e o aviso no celular. Nenhuma operação é feita
        e a carteira não muda."""
        with self.tick_lock:
            views = [v for v in (self.snapshot or {}).get("robots", []) if v["state"] not in ("ejected", "offline")]
            if robot_id:
                views = [v for v in views if v["id"] == robot_id]
            if not views:
                raise CommandError("Nenhum robô disponível para simular o ganho.")
            view = random.choice(views)
            amount = round(random.uniform(1.5, 12), 2)
            text = f"SIMULAÇÃO: {view['name']} lucrou {fmt_money(amount)} {self.config['currency']} (teste, a carteira não muda)"
            self._event(now_ms(), "close", view["id"], text, pnl=amount, simulated=True)
            self._push(f"SIMULAÇÃO: {view['name']} lucrou {fmt_money(amount)} {self.config['currency']}",
                       "Teste da reação de ganho. Nenhuma operação foi feita e a carteira não mudou.", 3, "test_tube")
            self._tick(now_ms())
            return text

    # ---------- ordens dadas pela tela ----------

    def _live_blocked(self, bot):
        return bot is not None and not bot.get("dry_run", True) and not self.config.get("orders", {}).get("allow_live")

    def hire(self, fields):
        """Contrata um funcionário novo e já o coloca para trabalhar na função escolhida."""
        if not self.employees:
            raise CommandError("Contratação indisponível nesta mesa.")
        with self.tick_lock:
            bot_name = self.config.get("employees_bot") or next(iter(self.sources))
            source = self.sources[bot_name]
            demo = self.config["mode"] == "demo"
            pairs = source.pairs() if hasattr(source, "pairs") else self.config["pairs"]
            robots = self.robots
            taken_pairs = set() if demo else {r.get("pair") for r in robots if r["bot"] == bot_name and r.get("pair")}
            orders = self.config["orders"]
            try:
                robot = self.employees.create(
                    fields, bot=bot_name, pairs=pairs, taken_ids={r["id"] for r in robots}, taken_pairs=taken_pairs,
                    default_stake=orders["default_stake"], max_stake=orders["max_stake"], demo=demo,
                )
            except EmployeeError as exc:
                raise CommandError(str(exc)) from None
            try:
                source.add_robot(robot, self._works_alone(robot))
            except Exception as exc:
                self.employees.delete(robot["id"])
                raise CommandError(f"O bot recusou a contratação: {exc}") from None
            self._event(now_ms(), "hire", robot["id"], f"{robot['name']} entrou para a equipe: {ROLES[robot['role']]} em {robot['pair']}.")
            self._tick(now_ms())
            return robot

    @staticmethod
    def _works_alone(robot):
        return robot.get("role", "auto") == "auto" and not robot.get("paused")

    def command(self, robot_id, action, params=None):
        """Executa uma ordem dada pela tela e devolve a frase que vai para o painel de acontecimentos."""
        params = params or {}
        if not self.employees:
            raise CommandError("Ordens pela tela indisponíveis nesta mesa.")
        with self.tick_lock:
            robot = {r["id"]: r for r in self.robots}.get(robot_id)
            if not robot:
                raise CommandError("Funcionário não encontrado.")
            view = next((v for v in (self.snapshot or {}).get("robots", []) if v["id"] == robot_id), None) or {}
            source = self.sources.get(robot["bot"])
            bot = self._last_bots.get(robot["bot"])
            handlers = {"buy": self._buy, "sell": self._sell, "pause": self._pause, "resume": self._pause,
                        "role": self._change_role, "fire": self._fire}
            if action not in handlers:
                raise CommandError("Ordem desconhecida.")
            try:
                message = handlers[action](robot, view, source, bot, action, params)
            except CommandError:
                raise
            except Exception as exc:  # erro da corretora/bot: mostra o motivo sem derrubar a mesa
                raise CommandError(f"O bot recusou a ordem: {exc}") from None
            self._event(now_ms(), "order", robot_id, message)
            self._tick(now_ms())
            return message

    def _buy(self, robot, view, source, bot, action, params):
        name, pair, currency = robot["name"], robot.get("pair"), self.config["currency"]
        orders = self.config["orders"]
        if not pair:
            raise CommandError("Este robô cuida do bot inteiro; dê ordens de compra pelo FreqUI.")
        if robot.get("role") == "watch":
            raise CommandError(f"{name} só vigia o preço. Mude a função dele para poder comprar.")
        if robot["id"] in self.state["ejected"]:
            raise CommandError(f"{name} foi ejetado por bater o limite de perda e não pode comprar.")
        if self.state["killed"]:
            raise CommandError("A kill-line da carteira foi atingida: compras bloqueadas.")
        if view.get("open_trades"):
            raise CommandError(f"{name} já tem uma posição aberta em {pair}. Venda antes de comprar de novo.")
        if not bot or not bot.get("online"):
            raise CommandError(f"O bot {robot['bot']} está offline.")
        if self._live_blocked(bot):
            raise CommandError("Ordens com dinheiro real estão bloqueadas nesta fase do projeto (só simulação).")
        try:
            stake = float(params.get("stake") or robot.get("stake") or orders["default_stake"])
        except (TypeError, ValueError):
            raise CommandError("O valor da compra precisa ser um número.") from None
        if not 1 <= stake <= orders["max_stake"]:
            raise CommandError(f"O valor da compra precisa ficar entre 1 e {orders['max_stake']:g} {currency}.")
        source.buy(robot, stake)
        return f"Ordem sua: {name} comprou {pair} com {fmt_money(stake).lstrip('+')} {currency}."

    def _sell(self, robot, view, source, bot, action, params):
        trades = view.get("open_trades") or []
        if not trades:
            raise CommandError(f"{robot['name']} não tem posição aberta para vender.")
        if self._live_blocked(bot):
            raise CommandError("Ordens com dinheiro real estão bloqueadas nesta fase do projeto (só simulação).")
        cancelled = source.sell(robot, [t["id"] for t in trades]) or 0
        if cancelled == len(trades):
            return f"Ordem sua: a compra de {robot['name']} em {robot['pair']} ainda não tinha sido executada e foi cancelada."
        result = sum(t["pnl"] for t in trades)
        return f"Ordem sua: {robot['name']} vendeu {robot['pair']} a mercado ({fmt_money(result)} {self.config['currency']})."

    def _require_pair(self, robot):
        if not robot.get("pair"):
            raise CommandError("Pausar e mudar função só funcionam para funcionários de uma moeda.")

    def _pause(self, robot, view, source, bot, action, params):
        self._require_pair(robot)
        paused = action == "pause"
        self.employees.update(robot["id"], paused=paused)
        updated = {**robot, "paused": paused}
        source.set_auto(updated, self._works_alone(updated))
        return f"Ordem sua: {robot['name']} {'entrou em pausa' if paused else 'voltou ao trabalho'}."

    def _change_role(self, robot, view, source, bot, action, params):
        self._require_pair(robot)
        role = params.get("role")
        if role not in ROLES:
            raise CommandError("Escolha uma função válida.")
        if role == "watch" and not (robot.get("alert_above") or robot.get("alert_below")):
            price = self._prices.get(robot["pair"])
            if not price:
                raise CommandError("Sem cotação agora para definir os alertas. Tente de novo em alguns segundos.")
            # sem valores definidos, vigia uma variação de 2% para cada lado a partir do preço atual
            self.employees.update(robot["id"], alert_above=round(price * 1.02, 6), alert_below=round(price * 0.98, 6))
        self.employees.update(robot["id"], role=role)
        updated = {**robot, "role": role}
        source.set_auto(updated, self._works_alone(updated))
        return f"Ordem sua: {robot['name']} agora tem a função “{ROLES[role]}”."

    def _fire(self, robot, view, source, bot, action, params):
        if not robot.get("employee"):
            raise CommandError("Só dá para demitir funcionários contratados pela tela. Robôs do config podem ser pausados.")
        if view.get("open_trades"):
            raise CommandError(f"{robot['name']} tem posição aberta. Venda antes de demitir.")
        source.remove_robot(robot)
        self.employees.delete(robot["id"])
        return f"{robot['name']} saiu da equipe."

    def _hire_options(self):
        if not self.employees or not self.sources:
            return None
        source = self.sources[self.config.get("employees_bot") or next(iter(self.sources))]
        orders = self.config["orders"]
        return {
            "pairs": source.pairs() if hasattr(source, "pairs") else self.config["pairs"],
            "roles": ROLES,
            "default_stake": orders["default_stake"],
            "max_stake": orders["max_stake"],
        }

    def _build_snapshot(self, views, portfolio, bots, ts):
        refresh = self.config["refresh_seconds"]
        online = [bot for bot in bots.values() if bot.get("online")]
        if any(bot.get("demo") for bot in bots.values()):
            mode = "demo"
        elif any(not bot.get("dry_run", True) for bot in online):
            mode = "live"
        elif online:
            mode = "dry_run"
        else:
            mode = "offline"
        return {
            "ts": ts,
            "updated_at": iso(ts),
            "next_tick_at": ts + refresh * 1000,
            "refresh_seconds": refresh,
            "mode": mode,
            "currency": self.config["currency"],
            "enforce": bool(self.config.get("enforce")),
            "portfolio": portfolio,
            "robots": views,
            "events": self.state["events"][:30],
            "hire": self._hire_options(),
            "orders": {"live_blocked": any(self._live_blocked(bot) for bot in online)},
            "bots": [
                {
                    "name": name,
                    "online": bool(bot.get("online")),
                    "dry_run": bot.get("dry_run"),
                    "strategy": bot.get("strategy"),
                    "state": bot.get("state"),
                    "error": bot.get("error"),
                }
                for name, bot in bots.items()
            ],
        }


def reinstate(state_path, robot_id=None, kill_line=False):
    """Devolve um robô à mesa. O pico de drawdown recomeça do zero a partir de agora."""
    state = read_state(state_path)
    messages = []
    if robot_id:
        if robot_id not in state["ejected"]:
            messages.append(f"{robot_id} não está ejetado.")
        else:
            del state["ejected"][robot_id]
            state["peaks"].pop(robot_id, None)
            state["reset"][robot_id] = now_ms()
            messages.append(f"{robot_id} voltou para a mesa; o drawdown dele conta a partir de agora.")
    if kill_line:
        state["killed"] = None
        messages.append(
            "Kill-line rearmada. Se a perda total ainda estiver além do limite ela dispara de novo: "
            "ajuste kill_line/starting_capital no config antes. Os robôs ejetados continuam fora até você reintegrá-los."
        )
    state["rev"] = uuid.uuid4().hex  # avisa o servidor em execução para recarregar
    write_state(state_path, state)
    return "\n".join(messages) or "Nada a fazer: informe o id do robô ou --kill-line."
