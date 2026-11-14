# x19login — Cubeloom 的网易账号登录助手

用**网易邮箱 / 手机号 + 密码（或短信）**换到 x19 的 `entity_id + token`，供 Cubeloom
查询租赁服地址并启动 NTvector。零第三方依赖（只用 Go 标准库）。

## 构建

```bash
npm run build:x19login
# 产物：tools/x19login/bin/x19login（本机）/ x19login.exe（Windows）
```

`npm run build` 会自动把 host + Windows 两个版本打进 `build/server/`，
Electron 运行时由 `FB_X19LOGIN` 指向 `server/x19login[.exe]`。

## 协议（stdin / stdout，一行一个 JSON）

stdin 第一行：

```json
{"mode":"email|phone|sms|sauth","account":"…","password":"…","sauth":"…","cache":"…","project":"x19","gv":"c1.25.0"}
```

stdout 事件：

```json
{"event":"notice","message":"设备指纹已注册"}
{"event":"sms_required","upstream":false,"phone":"138****0000"}
{"event":"sms_upstream","phone":"…","number":"…","content":"…"}
{"event":"password_required"}
{"event":"result","entity_id":123456789,"token":"…","name":"…"}
{"event":"error","message":"…"}
```

stdin 后续：

```json
{"code":"123456"}   // 回答 sms_required
{"ack":"ok"}        // 回答 sms_upstream（用户已发完上行短信）
{"password":"…"}    // 回答 password_required
```

口令只存在于进程内存，不写盘、不回显；进程拿到 token 后立即退出（不维持心跳，
因为随后启动的引擎会用自己的 MD5Token 走认证）。

## 来源与许可

- 登录实现：`internal/neteasex19/` 是 [NeteaseLogin](https://github.com/DHY0627/NeteaseLogin)
  的副本（commit `e1058332725db30ae128efd78a8435fa9703d76e`，MIT，见 `LICENSE`）；
- 本目录的 `main.go` 只做 JSON 协议适配，同样以 MIT 分发；
- 上游只依赖 Go 标准库，所以可以离线 `CGO_ENABLED=0` 交叉编译。
