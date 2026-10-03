"""Funcionários contratados pela tela da mesa: quem são, que função têm e se estão pausados."""
import json
import os
import re
import time
from pathlib import Path


def now_ms():
    return int(time.time() * 1000)

ROLES = {
    "auto": "Operar sozinho",
    "manual": "Só sob meu comando",
    "watch": "Vigiar preço e avisar",
}


class EmployeeError(ValueError):
    """Pedido inválido, com mensagem pronta para mostrar na tela."""


def _number(value, label, minimum=None, maximum=None, required=True):
    if value in (None, ""):
        if required:
            raise EmployeeError(f"Informe {label}.")
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise EmployeeError(f"{label[0].upper()}{label[1:]} precisa ser um número.") from None
    if minimum is not None and number < minimum:
        raise EmployeeError(f"{label[0].upper()}{label[1:]} precisa ser pelo menos {minimum:g}.")
    if maximum is not None and number > maximum:
        raise EmployeeError(f"{label[0].upper()}{label[1:]} pode ser no máximo {maximum:g}.")
    return round(number, 8)


class EmployeeStore:
    """Guarda em JSON os funcionários criados e os ajustes (pausa, função) feitos em qualquer robô."""

    def __init__(self, path):
        self.path = Path(path)
        self.data = {"employees": [], "overrides": {}}
        if self.path.exists():
            self.data.update(json.loads(self.path.read_text(encoding="utf-8")))

    def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.data, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(tmp, self.path)

    def employees(self):
        return [dict(e) for e in self.data["employees"]]

    def apply(self, robot):
        return {**robot, **self.data["overrides"].get(robot["id"], {})}

    def create(self, fields, *, bot, pairs, taken_ids, taken_pairs, default_stake, max_stake, demo):
        name = str(fields.get("name") or "").strip()
        if not 1 <= len(name) <= 40:
            raise EmployeeError("Dê um nome de 1 a 40 letras ao funcionário.")
        pair = fields.get("pair")
        if pair not in pairs:
            raise EmployeeError("Escolha uma das moedas da lista.")
        if pair in taken_pairs:
            raise EmployeeError(f"Já existe um funcionário cuidando de {pair} neste bot. Escolha outra moeda.")
        role = fields.get("role")
        if role not in ROLES:
            raise EmployeeError("Escolha a função do funcionário.")
        stake = _number(fields.get("stake") or default_stake, "o valor por operação", 1, max_stake)
        # vigia não opera: o limite de perda só importa se um dia ele mudar de função
        max_drawdown = _number(fields.get("max_drawdown") or (stake * 0.3 if role == "watch" else None),
                               "o limite de perda", 0.01, 10_000_000)
        alert_above = _number(fields.get("alert_above"), "o preço de alerta acima", 0, required=False) or None
        alert_below = _number(fields.get("alert_below"), "o preço de alerta abaixo", 0, required=False) or None
        if role == "watch" and not (alert_above or alert_below):
            raise EmployeeError("Para vigiar, informe pelo menos um preço: avisar acima de ou abaixo de.")

        base = re.sub(r"[^a-z0-9]+", "-", name.lower().encode("ascii", "ignore").decode()).strip("-") or "funcionario"
        rid, n = base, 2
        while rid in taken_ids:
            rid, n = f"{base}-{n}", n + 1
        robot = {
            "id": rid,
            "name": name,
            "bot": bot,
            "pair": pair,
            "role": role,
            "stake": stake,
            "max_drawdown": max_drawdown,
            "alert_above": alert_above,
            "alert_below": alert_below,
            "paused": False,
            "employee": True,
            "since": now_ms(),
            # no demo vários robôs dividem o mesmo par; a "estratégia" separa as operações de cada um
            "strategy": f"mesa-{rid}" if demo else None,
        }
        self.data["employees"].append(robot)
        self.save()
        return dict(robot)

    def update(self, robot_id, **changes):
        for employee in self.data["employees"]:
            if employee["id"] == robot_id:
                employee.update(changes)
                break
        else:
            self.data["overrides"].setdefault(robot_id, {}).update(changes)
        self.save()

    def delete(self, robot_id):
        self.data["employees"] = [e for e in self.data["employees"] if e["id"] != robot_id]
        self.data["overrides"].pop(robot_id, None)
        self.save()
