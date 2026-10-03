"""Carrega config/floor.json e o .env (segredos ficam só no .env)."""
import copy
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

DEFAULTS = {
    "mode": "demo",
    "refresh_seconds": 20,
    "host": "127.0.0.1",
    "port": 8420,
    "currency": "USDT",
    "enforce": False,
    "portfolio": {"starting_capital": 1000, "kill_line": None},
    "demo": {"robots": 12, "seed": None, "stake": 100},
    # ordens dadas pela tela: dinheiro real fica bloqueado até a fase 4 do plano
    "orders": {"allow_live": False, "default_stake": 100, "max_stake": 200},
    "pairs": ["BTC/USDT", "ETH/USDT", "SOL/USDT"],
    "employees_bot": None,
    "bots": [],
    "robots": [],
}


def load_env(path):
    """Lê KEY=VALUE do .env sem sobrescrever variáveis já definidas no sistema."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def load_config(path=None):
    load_env(ROOT / ".env")
    path = Path(path) if path else ROOT / "config" / "floor.json"
    user = json.loads(path.read_text(encoding="utf-8"))

    config = copy.deepcopy(DEFAULTS)
    for key, value in user.items():
        if isinstance(value, dict) and isinstance(config.get(key), dict):
            config[key].update(value)
        else:
            config[key] = value

    if config["mode"] not in ("demo", "freqtrade"):
        raise ValueError(f"mode inválido: {config['mode']!r} (use 'demo' ou 'freqtrade')")
    if config["mode"] == "freqtrade" and not config["bots"]:
        raise ValueError("mode 'freqtrade' precisa de ao menos um item em 'bots'")
    bot_names = {bot["name"] for bot in config["bots"]}
    for robot in config["robots"]:
        if "id" not in robot or "bot" not in robot:
            raise ValueError(f"robô sem 'id' ou 'bot': {robot}")
        if config["mode"] == "freqtrade" and robot["bot"] not in bot_names:
            raise ValueError(f"robô {robot['id']!r} aponta para bot inexistente {robot['bot']!r}")
    config["refresh_seconds"] = max(2, int(config["refresh_seconds"]))
    return config
