# -*- coding: utf-8 -*-
"""
Cubeloom 事件桥插件（NTvector 插件 / source 模式）

把 NTvector 的指令与聊天事件转成 Cubeloom 需要的 NDJSON 协议：
  客户端 → 机器人：{"type":"command","cmd":"command|command_nowait|pos|identity|players|get_block","args":{...},"id":"..."}
  机器人 → 客户端：{"type":"hello"} / {"type":"auth_ok"} / {"type":"result","id":...} / {"type":"event",...}

用本机 TCP（127.0.0.1）而不是 UNIX socket：Windows 下更省事，跨平台一致。

配置：plugins 根目录下的 cubeloom_bridge.json
  {"host":"127.0.0.1","port":17999,"token":"改成随机串","protocol":860,"gameVersion":"1.21.120"}

Cubeloom 侧：
  FB_NETEASE_SOCKET=tcp://127.0.0.1:17999
  FB_NETEASE_TOKEN=<同一个 token>
"""
import hmac
import json
import os
import socket
import threading

import engine

_LOG_PREFIX = "[cubeloom_bridge] "
_CFG = {"host": "127.0.0.1", "port": 17999, "token": "", "protocol": 860, "gameVersion": "1.21.120"}
_STATE = {
    "stop": False,
    "server": None,
    "client": None,
    "threads": [],
    "players": [],
    "identity": {},
}
_LOCK = threading.Lock()


def _log(msg):
    print(_LOG_PREFIX + str(msg))


def _config_path():
    # __file__ = <插件根>/cubeloom_bridge/__init__.py，配置放在插件根
    return os.path.join(os.path.dirname(os.path.dirname(__file__)), "cubeloom_bridge.json")


def _load_config():
    path = _config_path()
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            _CFG.update(data)
        _log("配置已加载：%s" % path)
    except FileNotFoundError:
        _log("没有找到 %s，使用默认值（请创建并填入 token）" % path)
    except Exception as e:
        _log("配置读取失败：%s" % e)


def _send(obj):
    with _LOCK:
        client = _STATE.get("client")
        if client is None:
            return
        try:
            client.sendall((json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8"))
        except Exception as e:
            _log("发送失败：%s" % e)
            _STATE["client"] = None


def _reply(msg, ok, data=None, error=None):
    mid = msg.get("id") if isinstance(msg, dict) else None
    if not mid:
        return
    # command_nowait 用 n 前缀，不需要回执
    if str(mid).startswith("n"):
        return
    out = {"type": "result", "id": mid, "ok": bool(ok)}
    if data is not None:
        out["data"] = data
    if error:
        out["error"] = str(error)
    _send(out)


def _handle_command(msg):
    cmd = msg.get("cmd")
    args = msg.get("args") or {}
    try:
        if cmd in ("command", "command_nowait"):
            text = str(args.get("text") or "").strip()
            if not text:
                return _reply(msg, False, error="text 为空")
            if text.startswith("/"):
                text = text[1:]
            engine.command(text)
            if cmd == "command":
                _reply(msg, True, {"statusCode": 0, "message": "sent"})
            return
        if cmd == "pos":
            x, y, z = engine.get_pot_x(), engine.get_pot_y(), engine.get_pot_z()
            if x is None or y is None or z is None:
                return _reply(msg, False, error="坐标尚未被服务器确认")
            return _reply(msg, True, {"x": x, "y": y, "z": z})
        if cmd == "identity":
            return _reply(msg, True, dict(_STATE.get("identity") or {}))
        if cmd == "players":
            return _reply(msg, True, list(_STATE.get("players") or []))
        if cmd == "get_block":
            return _reply(msg, False, error="NTvector 插件未实现本地方块缓存读取")
        return _reply(msg, False, error="未知命令：%s" % cmd)
    except Exception as e:
        _log("执行命令失败：%s" % e)
        return _reply(msg, False, error=str(e))


def _client_loop(conn, addr):
    _log("客户端已连接：%s" % (addr,))
    try:
        conn.sendall((json.dumps({"type": "hello", "protocol": int(_CFG.get("protocol", 860)),
                                  "gameVersion": _CFG.get("gameVersion", "1.21.120")}) + "\n").encode("utf-8"))
    except Exception:
        pass
    buf = ""
    authed = False
    conn.settimeout(1.0)
    try:
        while not _STATE["stop"] and _STATE.get("client") is conn:
            try:
                chunk = conn.recv(65536)
            except socket.timeout:
                continue
            except OSError:
                break
            if not chunk:
                break
            buf += chunk.decode("utf-8", "replace")
            while "\n" in buf:
                line, buf = buf.split("\n", 1)
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except Exception:
                    _log("收到非法 JSON，已忽略")
                    continue
                mtype = msg.get("type")
                if mtype == "auth":
                    token = str(msg.get("token") or "")
                    if hmac.compare_digest(token, str(_CFG.get("token") or "")):
                        authed = True
                        _send({"type": "auth_ok", "protocol": int(_CFG.get("protocol", 860)),
                               "gameVersion": _CFG.get("gameVersion", "1.21.120")})
                        _log("鉴权通过")
                    else:
                        _send({"type": "auth_fail", "error": "token 不匹配"})
                        _log("鉴权失败")
                    continue
                if mtype == "subscribe":
                    authed = True  # 已鉴权客户端的重连重订阅
                    continue
                if mtype == "command":
                    if not authed:
                        _reply(msg, False, error="未鉴权")
                        continue
                    _handle_command(msg)
    except Exception as e:
        _log("客户端循环异常：%s" % e)
    finally:
        try:
            conn.close()
        except Exception:
            pass
        with _LOCK:
            if _STATE.get("client") is conn:
                _STATE["client"] = None
        _log("客户端已断开")


def _server_loop():
    host = str(_CFG.get("host", "127.0.0.1"))
    port = int(_CFG.get("port", 17999))
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        srv.bind((host, port))
        srv.listen(1)
    except Exception as e:
        _log("监听 %s:%s 失败：%s" % (host, port, e))
        return
    srv.settimeout(0.5)
    _STATE["server"] = srv
    _log("事件桥监听中：%s:%s" % (host, port))
    while not _STATE["stop"]:
        try:
            conn, addr = srv.accept()
        except socket.timeout:
            continue
        except OSError:
            break
        with _LOCK:
            old = _STATE.get("client")
            _STATE["client"] = conn
        if old is not None:
            try:
                old.close()
            except Exception:
                pass
        threading.Thread(target=_client_loop, args=(conn, addr), daemon=True).start()
    try:
        srv.close()
    except Exception:
        pass
    _log("事件桥已停止")


def _online_bot_name():
    try:
        names = engine.get_online_players()
        if names:
            return names[0]
    except Exception:
        pass
    return ""


# ---------- 事件转发 ----------
def _on_text(args):
    data = args[0] if args and isinstance(args[0], dict) else {}
    _send({"type": "event", "event": "on_text",
           "fields": {"source": data.get("source_name", ""), "message": data.get("message", "")}})


def _on_players(args):
    players = args[0] if args and isinstance(args[0], list) else []
    _STATE["players"] = players
    _send({"type": "event", "event": "on_player_list", "fields": {"players": players}})


def _on_disconnect(args):
    _send({"type": "event", "event": "on_disconnect", "fields": {}})


def _on_start(args):
    _state_reset()
    _load_config()
    try:
        rt = engine.get_entity_runtime_id()
    except Exception:
        rt = None
    _STATE["identity"] = {"name": _online_bot_name(), "runtimeId": rt, "source": "NTvector"}
    _STATE["threads"] = [threading.Thread(target=_server_loop, daemon=True)]
    _STATE["threads"][0].start()
    engine.register(_on_text, "OnTextPacket")
    engine.register(_on_players, "on_player_list")
    engine.register(_on_disconnect, "on_disconnect")
    _send({"type": "event", "event": "bridge_ready", "fields": {"port": _CFG.get("port")}})


def _state_reset():
    _STATE["stop"] = False
    _STATE["client"] = None
    _STATE["server"] = None


def on_uninit():
    """热重载/退出前必须停掉后台线程，否则旧线程会引用已卸载的模块。"""
    _STATE["stop"] = True
    srv = _STATE.get("server")
    client = _STATE.get("client")
    for s in (srv, client):
        try:
            if s is not None:
                s.close()
        except Exception:
            pass
    _STATE["server"] = None
    _STATE["client"] = None
    _log("插件已卸载")


engine.register(_on_start, "ModEventStartUp")
