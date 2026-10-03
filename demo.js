// Demonstração sem servidor: a mesma lógica da mesa (os arquivos Python de py/floor) roda no
// navegador pelo Pyodide, com robôs e dinheiro fictícios. Nada sai do aparelho de quem abre.
// Este arquivo responde aos pedidos /api/... que a sala (floor.js) faria ao servidor.
import { loadPyodide } from 'https://cdn.jsdelivr.net/pyodide/v0.28.3/full/pyodide.mjs';

const FILES = ['__init__.py', 'config.py', 'core.py', 'employees.py', 'montecarlo.py', 'sources.py'];
const CONFIG = {
  mode: 'demo',
  refresh_seconds: 5,
  currency: 'USDT',
  enforce: true,
  portfolio: { starting_capital: 1000, kill_line: 150 },
  orders: { allow_live: false, default_stake: 100, max_stake: 200 },
  demo: { robots: 14, seed: null, stake: 100 },
};
const GLUE = `
import json
from floor.config import load_config
from floor.core import CommandError, FloorEngine
from floor.employees import EmployeeStore
from floor.sources import build_sources

config = load_config("/mesa/floor.json")
sources, robots = build_sources(config)
engine = FloorEngine(config, sources, robots, "/mesa/state.json", EmployeeStore("/mesa/staff.json"))
engine.tick()

def snapshot():
    return json.dumps(engine.snapshot, ensure_ascii=False)

def post(path, body):
    payload = json.loads(body or "{}")
    parts = path.strip("/").split("/")
    try:
        if parts == ["api", "simulate", "gain"]:
            return 200, json.dumps({"ok": True, "message": engine.simulate_gain(payload.get("robot"))}, ensure_ascii=False)
        if parts == ["api", "employees"]:
            robot = engine.hire(payload)
            return 201, json.dumps({"ok": True, "id": robot["id"],
                                    "message": f"{robot['name']} entrou para a equipe e já está na mesa."}, ensure_ascii=False)
        if len(parts) == 4 and parts[:2] == ["api", "employees"]:
            return 200, json.dumps({"ok": True, "message": engine.command(parts[2], parts[3], payload)}, ensure_ascii=False)
        return 404, json.dumps({"error": "Endereço desconhecido."})
    except (CommandError, ValueError) as exc:
        return 400, json.dumps({"error": str(exc)}, ensure_ascii=False)
`;

let py = null;
let failed = false;
const loadingText = () => document.getElementById('loading-text');

const ready = (async () => {
  const pyodide = await loadPyodide();
  if (loadingText()) loadingText().textContent = 'Contratando os robôs…';
  pyodide.FS.mkdirTree('/mesa/floor');
  const sources = await Promise.all(FILES.map(async (f) => {
    const res = await fetch(`py/floor/${f}`);
    if (!res.ok) throw new Error(`arquivo ${f}: HTTP ${res.status}`);
    return res.text();
  }));
  FILES.forEach((f, i) => pyodide.FS.writeFile(`/mesa/floor/${f}`, sources[i]));
  pyodide.FS.writeFile('/mesa/floor.json', JSON.stringify(CONFIG));
  pyodide.runPython('import sys; sys.path.insert(0, "/mesa")');
  pyodide.runPython(GLUE);
  py = { snapshot: pyodide.globals.get('snapshot'), post: pyodide.globals.get('post'), engine: pyodide.globals.get('engine') };
  setInterval(() => py.engine.tick(), CONFIG.refresh_seconds * 1000);
})().catch((err) => {
  failed = true;
  console.error(err);
  if (loadingText()) loadingText().textContent = 'Não consegui abrir a demonstração. Confira a internet e recarregue a página.';
});

const json = (status, body) => new Response(body, { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return realFetch(input, init);
  if (failed) return json(503, JSON.stringify({ error: 'demonstração indisponível' }));
  if (!py) return json(200, JSON.stringify({ loading: true }));
  if ((init.method || 'GET').toUpperCase() === 'GET') return json(200, py.snapshot());
  const result = py.post(url.pathname, init.body || '{}');
  const [status, body] = result.toJs();
  result.destroy();
  return json(status, body);
};
