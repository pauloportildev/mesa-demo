"""Fontes de dados da mesa: a API REST do Freqtrade ou um simulador (modo demo)."""
import base64
import json
import os
import random
import re
import urllib.error
import urllib.parse
import urllib.request

from .core import fmt_money, iso, now_ms
from .montecarlo import monte_carlo_drawdown

LOCK_UNTIL = "2099-12-31T00:00:00+00:00"


class FreqtradeSource:
    """Lê um bot Freqtrade pela API REST (api_server habilitado no config do bot)."""

    def __init__(self, bot, pairs=None):
        self.name = bot["name"]
        self._pairs = list(pairs or [])
        self.url = bot["url"].rstrip("/")
        password = os.environ.get(bot.get("password_env") or "", "") or bot.get("password", "")
        token = base64.b64encode(f"{bot.get('username', '')}:{password}".encode()).decode()
        self.headers = {"Authorization": f"Basic {token}", "Content-Type": "application/json"}
        self.timeout = float(bot.get("timeout", 10))
        self._closed = {}

    def _request(self, method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(f"{self.url}/api/v1{path}", data=data, method=method, headers=self.headers)
        with urllib.request.urlopen(request, timeout=self.timeout) as response:
            raw = response.read()
        return json.loads(raw) if raw else None

    def _merge_closed(self, trades):
        for trade in trades:
            if not trade.get("is_open"):
                self._closed[trade["trade_id"]] = trade

    def _sync_closed(self):
        # Busca só a primeira página a cada leitura; se faltar operação no cache, pagina tudo.
        page = self._request("GET", "/trades?limit=500&offset=0")
        self._merge_closed(page.get("trades", []))
        total = page.get("total_trades", 0)
        offset = 500
        while len(self._closed) < total and offset < total:
            page = self._request("GET", f"/trades?limit=500&offset={offset}")
            if not page.get("trades"):
                break
            self._merge_closed(page["trades"])
            offset += 500

    def fetch(self):
        try:
            config = self._request("GET", "/show_config")
            status = self._request("GET", "/status") or []
            self._sync_closed()
        except urllib.error.HTTPError as exc:
            reason = "usuário/senha recusados" if exc.code == 401 else f"HTTP {exc.code}"
            return {"name": self.name, "online": False, "error": reason}
        except (urllib.error.URLError, OSError, ValueError) as exc:
            return {"name": self.name, "online": False, "error": str(getattr(exc, "reason", exc))}
        return {
            "name": self.name,
            "online": True,
            "dry_run": bool(config.get("dry_run", True)),
            "strategy": config.get("strategy"),
            "state": config.get("state"),
            "open_trades": status,
            "closed_trades": list(self._closed.values()),
        }

    def _stop_entries(self):
        try:
            self._request("POST", "/stopentry")
        except urllib.error.HTTPError as exc:
            if exc.code != 404:
                raise
            self._request("POST", "/stopbuy")  # nome antigo do endpoint

    def eject_robot(self, robot, open_trade_ids):
        """Primeiro impede novas entradas, depois encerra o que está aberto."""
        notes = []
        if robot.get("pair"):
            self._request("POST", "/locks", [
                {"pair": robot["pair"], "side": "*", "until": LOCK_UNTIL, "reason": "trading-floor: teto de drawdown"}
            ])
            notes.append(f"Par {robot['pair']} bloqueado no bot {self.name}.")
        else:
            self._stop_entries()
            notes.append(f"Novas entradas desligadas no bot {self.name}.")
        for trade_id in open_trade_ids:
            self._request("POST", "/forceexit", {"tradeid": str(trade_id)})
        if open_trade_ids:
            notes.append(f"{len(open_trade_ids)} operação(ões) encerrada(s) a mercado.")
        return notes

    def kill_all(self):
        self._stop_entries()
        self._request("POST", "/forceexit", {"tradeid": "all"})
        self._request("POST", "/stop")
        return [f"Bot {self.name}: tudo encerrado e parado."]

    # ---------- ordens dadas pela tela (exige "force_entry_enable": true no config do bot) ----------

    def buy(self, robot, stake):
        # o Freqtrade só responde "Failed to enter position"; conferir o saldo antes dá o motivo certo
        balance = self._request("GET", "/balance") or {}
        stake_currency = balance.get("stake")
        free = next((float(c.get("free") or 0) for c in balance.get("currencies", [])
                     if c.get("currency") == stake_currency), None)
        if free is not None and free < stake:
            raise ValueError(f"saldo livre do bot {self.name} é {fmt_money(free)[1:]} {stake_currency}, menor que "
                             f"a compra de {fmt_money(stake)[1:]}. Venda uma posição ou diminua o valor.")
        self._request("POST", "/forceenter", {
            "pair": robot["pair"], "side": "long", "stakeamount": stake, "entry_tag": f"mesa:{robot['id']}",
        })

    def sell(self, robot, trade_ids):
        """Devolve quantas compras ainda pendentes foram canceladas: nesse caso o Freqtrade cancela a
        ordem e apaga a operação, mas responde com erro."""
        cancelled = 0
        for trade_id in trade_ids:
            try:
                self._request("POST", "/forceexit", {"tradeid": str(trade_id)})
            except urllib.error.HTTPError:
                if self._trade_exists(trade_id):
                    raise
                cancelled += 1
        return cancelled

    def _trade_exists(self, trade_id):
        try:
            self._request("GET", f"/trade/{trade_id}")
            return True
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return False
            raise

    def set_auto(self, robot, works_alone):
        """Trabalhar sozinho = estratégia livre no par. Caso contrário, trava as entradas da estratégia
        no par; as ordens dadas pela tela (forceenter) continuam passando."""
        self._unlock(robot["pair"])
        if not works_alone:
            reason = "mesa:pausado" if robot.get("paused") else "mesa:sob-comando"
            self._request("POST", "/locks", [{"pair": robot["pair"], "side": "*", "until": LOCK_UNTIL, "reason": reason}])

    def _unlock(self, pair):
        # só remove travas criadas pela tela; a trava de ejeção ("trading-floor: …") fica
        for lock in (self._request("GET", "/locks") or {}).get("locks", []):
            if lock.get("pair") == pair and str(lock.get("reason") or "").startswith("mesa:"):
                self._request("DELETE", f"/locks/{lock['id']}")

    def add_robot(self, robot, works_alone):
        self.set_auto(robot, works_alone)

    def remove_robot(self, robot):
        self._unlock(robot["pair"])

    def pairs(self):
        return self._pairs

    def prices(self, pairs):
        return binance_prices(pairs)


_price_cache = {"at": 0.0, "prices": {}}


def binance_prices(pairs, max_age=10):
    """Cotação pública da Binance (sem chave). Serve para vigias e para mostrar o preço na tela."""
    import time
    if not pairs:
        return {}
    if time.time() - _price_cache["at"] < max_age and all(p in _price_cache["prices"] for p in pairs):
        return {p: _price_cache["prices"][p] for p in pairs}
    by_symbol = {p.replace("/", ""): p for p in pairs}
    query = urllib.parse.quote(json.dumps(list(by_symbol), separators=(",", ":")))
    with urllib.request.urlopen(f"https://api.binance.com/api/v3/ticker/price?symbols={query}", timeout=5) as response:
        data = json.loads(response.read())
    prices = {by_symbol[d["symbol"]]: float(d["price"]) for d in data if d["symbol"] in by_symbol}
    _price_cache.update(at=time.time(), prices={**_price_cache["prices"], **prices})
    return prices


DEMO_STRATEGIES = {
    "TrendFollow": "Trend",
    "MeanReversion": "MeanRev",
    "Breakout": "Breakout",
    "Momentum": "Momentum",
    "RSIBounce": "RSI",
    "GridScalp": "Grid",
}
DEMO_PRICES = {
    "BTC/USDT": 79650.0,
    "ETH/USDT": 2640.0,
    "SOL/USDT": 151.0,
    "BNB/USDT": 598.0,
    "XRP/USDT": 0.62,
    "ADA/USDT": 0.41,
    "AVAX/USDT": 27.4,
    "LINK/USDT": 12.8,
    "DOGE/USDT": 0.118,
}
STOP_LOSS = -0.03
TAKE_PROFIT = 0.045
FEES = 0.002  # 0,1% por lado


class DemoSource:
    """Simula robôs com o mesmo formato de dados do Freqtrade, para ver a sala sem corretora.

    Gera 30 dias de histórico (que também alimenta o Monte Carlo do teto de cada robô) e
    depois avança um passo por leitura. Alguns robôs perdem a vantagem ao vivo, para mostrar a ejeção.
    """

    def __init__(self, config):
        demo = config.get("demo", {})
        self.rng = random.Random(demo.get("seed"))
        self.stake = float(demo.get("stake", 100))
        combos = [(s, p) for s in DEMO_STRATEGIES for p in DEMO_PRICES]
        self.rng.shuffle(combos)
        count = max(1, min(int(demo.get("robots", 12)), len(combos)))

        self.sims = []
        for strategy, pair in combos[:count]:
            coin = pair.split("/")[0]
            short = DEMO_STRATEGIES[strategy]
            self.sims.append({
                "id": re.sub(r"[^a-z0-9]+", "-", f"{short}-{coin}".lower()),
                "name": f"{short} {coin}",
                "strategy": strategy,
                "pair": pair,
                "edge": self.rng.uniform(0.0003, 0.0012),
                "vol": self.rng.uniform(0.004, 0.008),
                "entry": self.rng.uniform(0.03, 0.09),
                "doomed": False,
            })
        for sim in self.rng.sample(self.sims, max(1, count // 8)):
            sim["doomed"] = True

        self.prices_now = dict(DEMO_PRICES)
        self.open = {}
        self.closed = []
        self.disabled = set()
        self.seq = 0
        self.live_since = now_ms()

        step_ms = 2 * 3600 * 1000
        start = self.live_since - 30 * 24 * 3600 * 1000
        for i in range(360):
            self._step(start + i * step_ms, live=False)
        for sim_id in list(self.open):
            self._close(sim_id, self.live_since - 1)

        self._robots = []
        for sim in self.sims:
            pnls = [t["profit_abs"] for t in self.closed if t["strategy"] == sim["strategy"] and t["pair"] == sim["pair"]]
            ceiling = monte_carlo_drawdown(pnls, runs=2000, pct=99, seed=1)["ceiling"]
            self._robots.append({
                "id": sim["id"],
                "name": sim["name"],
                "bot": "demo",
                "pair": sim["pair"],
                "strategy": sim["strategy"],
                "max_drawdown": round(max(ceiling, self.stake * 0.15), 2),
                "since": self.live_since,
            })

    def robots(self):
        return self._robots

    def _open(self, sim, ts, stake=None):
        self.seq += 1
        price = self.prices_now[sim["pair"]]
        stake = stake or sim.get("stake") or self.stake
        self.open[sim["id"]] = {
            "trade_id": self.seq,
            "pair": sim["pair"],
            "strategy": sim["strategy"],
            "is_open": True,
            "is_short": False,
            "stake_amount": stake,
            "open_rate": price,
            "current_rate": price,
            "profit_ratio": -FEES,
            "profit_abs": -FEES * stake,
            "open_timestamp": ts,
            "open_date": iso(ts),
            "_move": 0.0,
        }

    def _close(self, sim_id, ts):
        trade = self.open.pop(sim_id)
        trade.update(is_open=False, close_timestamp=ts, close_date=iso(ts), close_profit_abs=trade["profit_abs"])
        self.closed.append(trade)

    def _step(self, ts, live):
        for pair in self.prices_now:
            self.prices_now[pair] *= 1 + self.rng.gauss(0, 0.0015)
        for sim in self.sims:
            if sim["id"] in self.disabled:
                continue
            trade = self.open.get(sim["id"])
            if trade is None:
                if sim.get("auto", True) and self.rng.random() < sim["entry"]:
                    self._open(sim, ts)
                continue
            drift = -0.0035 if (live and sim["doomed"]) else sim["edge"]
            trade["_move"] += self.rng.gauss(drift, sim["vol"])
            move = trade["_move"]
            trade["current_rate"] = trade["open_rate"] * (1 + move)
            trade["profit_ratio"] = move - FEES
            trade["profit_abs"] = round(trade["stake_amount"] * (move - FEES), 4)
            # quem opera sob comando só sai pelo stop/alvo ou quando você manda vender
            leave = sim.get("auto", True) and self.rng.random() < 0.05
            if move <= STOP_LOSS or move >= TAKE_PROFIT or leave:
                self._close(sim["id"], ts)

    def fetch(self):
        self._step(now_ms(), live=True)
        return {
            "name": "demo",
            "online": True,
            "demo": True,
            "dry_run": True,
            "strategy": "demo",
            "state": "running",
            "open_trades": [dict(t) for t in self.open.values()],
            "closed_trades": self.closed,
        }

    def eject_robot(self, robot, open_trade_ids):
        if robot["id"] in self.open:
            self._close(robot["id"], now_ms())
        self.disabled.add(robot["id"])
        return ["Operação encerrada e robô desligado (demo)."]

    def kill_all(self):
        for sim_id in list(self.open):
            self._close(sim_id, now_ms())
        self.disabled.update(sim["id"] for sim in self.sims)
        return ["Todos os robôs demo desligados."]

    # ---------- ordens dadas pela tela ----------

    def _sim(self, robot):
        sim = next((s for s in self.sims if s["id"] == robot["id"]), None)
        if sim is None:
            raise ValueError(f"robô {robot['id']} não existe no simulador")
        return sim

    def add_robot(self, robot, works_alone):
        self.sims.append({
            "id": robot["id"], "name": robot["name"], "strategy": robot["strategy"], "pair": robot["pair"],
            "edge": self.rng.uniform(0.0003, 0.0012), "vol": self.rng.uniform(0.004, 0.008),
            "entry": self.rng.uniform(0.03, 0.09), "doomed": False, "stake": robot.get("stake"), "auto": works_alone,
        })

    def remove_robot(self, robot):
        self.sims = [s for s in self.sims if s["id"] != robot["id"]]

    def buy(self, robot, stake):
        sim = self._sim(robot)
        if sim["id"] in self.open:
            raise ValueError("já existe posição aberta")
        if sim["id"] in self.disabled:
            raise ValueError("robô desligado pela ejeção")
        self._open(sim, now_ms(), stake)

    def sell(self, robot, trade_ids):
        if robot["id"] in self.open:
            self._close(robot["id"], now_ms())

    def set_auto(self, robot, works_alone):
        self._sim(robot)["auto"] = works_alone

    def pairs(self):
        return list(DEMO_PRICES)

    def prices(self, pairs):
        return {p: self.prices_now[p] for p in pairs if p in self.prices_now}


def build_sources(config):
    """Retorna ({nome_do_bot: fonte}, [robôs])."""
    if config["mode"] == "demo":
        demo = DemoSource(config)
        return {"demo": demo}, demo.robots()
    sources = {bot["name"]: FreqtradeSource(bot, config["pairs"]) for bot in config["bots"]}
    robots = [dict(robot) for robot in config["robots"]] or [
        {"id": name, "name": name, "bot": name} for name in sources
    ]
    for robot in robots:
        robot.setdefault("name", robot["id"])
    return sources, robots
