/**
 * 4399 渠道登录 → 网易 sauth。
 *
 * 网易中国版的「4399 版」是渠道服：先在 4399 通行证登录，再拿 4399 的
 * 登录票据去换网易 x19 的 sauth（`login_channel=4399pc`），之后和官服账号一样
 * 走 `tools/x19login` 换 token。
 *
 * 协议来源（只取流程，不复制代码）：
 *   · adb-lanlu/4399Register 的 CookieGenerator.py / CookieTransfer.py
 *   · adb-lanlu/JS4399MCForCs 的 JS4399MC.cs
 *
 * 流程：
 *   1) GET  ptlogin.4399.com/ptlogin/verify.do?...        → 是否要验证码（captchaId）
 *   2) POST ptlogin.4399.com/ptlogin/login.do?v=1         → Set-Cookie: Uauth / Puser
 *   3) POST ptlogin.4399.com/ptlogin/checkKidLoginUserCookie.do?...  → 302，最终 URL 带 queryStr
 *   4) GET  microgame.5054399.net/v2/service/sdk/info?queryStr=... → sdk_login_data
 *   5) sdk_login_data → 网易 sauth（gameid=x19, login_channel=4399pc）
 *
 * 所谓「cookie 登录」就是把第 2 步换成用户自己贴 `Uauth=...; Puser=...`，直接做 3~5 步。
 */

const PTL_HOST = "http://ptlogin.4399.com";
const SDK_INFO_URL = "https://microgame.5054399.net/v2/service/sdk/info?callback=";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

export type FetchLike = (input: string, init?: any) => Promise<any>;

export type SauthJson = Record<string, any>;

/** 4399 的 sdk_login_data 解析结果（字段名来自上游实现） */
export type SdkLoginData = {
  uid: string;
  token: string;
  username: string;
  time: string;
};

/** 解析 `a=1; b=2` 形式的 cookie 串，忽略大小写与多余空白 */
export function parse4399Cookie(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(input || "").split(/[;\n]/)) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

/** 判断这段文本像什么：网易 sauth JSON / 4399 cookie / 未知 */
export function detectLoginInput(input: string): "sauth" | "cookie4399" | "empty" | "unknown" {
  const s = String(input || "").trim();
  if (!s) return "empty";
  if (s.startsWith("{")) {
    try {
      const obj = JSON.parse(s);
      if (obj && (obj.sauth_json || obj.sdkuid || obj.gameid || obj.sessionid)) return "sauth";
    } catch {
      return "unknown";
    }
    return "unknown";
  }
  const cookies = parse4399Cookie(s);
  if (cookies.Uauth || cookies.Puser) return "cookie4399";
  return "unknown";
}

/** 把 sdk_login_data（`uid=..&token=..&username=..&time=..`）转成网易 sauth 对象 */
export function sdkLoginDataToSauth(data: string | SdkLoginData, opts: { udid?: string; deviceid?: string; clientLoginSn?: string } = {}): SauthJson {
  const dict: Record<string, string> =
    typeof data === "string"
      ? Object.fromEntries(
          String(data)
            .split("&")
            .map((kv) => {
              const i = kv.indexOf("=");
              return i > 0 ? [kv.slice(0, i), kv.slice(i + 1)] : [kv, ""];
            })
            .filter(([k]) => !!k)
        )
      : { uid: data.uid, token: data.token, username: data.username, time: data.time };
  const uid = String(dict.uid || "").trim();
  const token = String(dict.token || "").trim();
  if (!uid || !token) throw new Error("4399 登录返回里缺少 uid/token（账号可能未实名或被风控）");
  const randHex = () => {
    const bytes = new Uint8Array(16);
    (globalThis.crypto as any)?.getRandomValues?.(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  };
  return {
    gameid: "x19",
    login_channel: "4399pc",
    app_channel: "4399pc",
    platform: "pc",
    sdkuid: uid,
    sessionid: token,
    sdk_version: "1.0.0",
    udid: opts.udid || randHex(),
    deviceid: opts.deviceid || randHex(),
    aim_info: JSON.stringify({ aim: "127.0.0.1", country: "CN", tz: "0800", tzid: "" }),
    client_login_sn: opts.clientLoginSn || randHex(),
    gas_token: "",
    source_platform: "pc",
    ip: "127.0.0.1",
    userid: String(dict.username || ""),
    realname: JSON.stringify({ realname_type: "0" }),
    timestamp: String(dict.time || ""),
  };
}

function cookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

/** 从 Set-Cookie 头里抽出 name=value（Node 18 的 undici 可能合并成一条） */
function pickSetCookies(res: any): Record<string, string> {
  const out: Record<string, string> = {};
  let list: string[] = [];
  try {
    if (typeof res.headers?.getSetCookie === "function") list = res.headers.getSetCookie();
  } catch {}
  if (!list.length) {
    const raw = res.headers?.get?.("set-cookie");
    if (raw) list = String(raw).split(/,(?=\s*[A-Za-z0-9_.-]+=)/);
  }
  for (const line of list) {
    const first = String(line).split(";")[0];
    const i = first.indexOf("=");
    if (i > 0) out[first.slice(0, i).trim()] = first.slice(i + 1).trim();
  }
  return out;
}

function randomUUIDish(): string {
  const bytes = new Uint8Array(16);
  (globalThis.crypto as any)?.getRandomValues?.(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type CaptchaChallenge = { captchaId: string; imageBase64: string };

/** 第一步：问 4399 这个账号现在要不要验证码；要的话顺便把图片取回来 */
export async function fetch4399Captcha(
  username: string,
  opts: { fetchImpl?: FetchLike; usessionId?: string } = {}
): Promise<CaptchaChallenge | null> {
  const f = opts.fetchImpl || fetch;
  const usession = opts.usessionId || randomUUIDish().replace(/-/g, "");
  const url =
    `${PTL_HOST}/ptlogin/verify.do?username=${encodeURIComponent(username)}` +
    `&appId=kid_wdsj&t=${encodeURIComponent(randomUUIDish())}&inputWidth=iptw2&v=1`;
  const res = await f(url, { headers: { "User-Agent": UA, Cookie: `USESSIONID=${usession}` } });
  const html = String(await res.text());
  const m = /captcha\.do\?captchaId=([\w\d]+)/.exec(html);
  if (!m) return null;
  const captchaId = m[1];
  const img = await f(`${PTL_HOST}/ptlogin/captcha.do?captchaId=${encodeURIComponent(captchaId)}`, {
    headers: { "User-Agent": UA, Cookie: `USESSIONID=${usession}` },
  });
  const buf = Buffer.from(await img.arrayBuffer());
  return { captchaId, imageBase64: `data:image/jpeg;base64,${buf.toString("base64")}` };
}

export type Login4399Options = {
  username: string;
  password: string;
  /** verify.do 拿到的 captchaId；没有验证码时留空 */
  captchaId?: string;
  captchaCode?: string;
  fetchImpl?: FetchLike;
  /** 自定义 udid/deviceid（测试用） */
  udid?: string;
  deviceid?: string;
};

/** 用 4399 账号密码换 sauth（可能需要验证码，先调 fetch4399Captcha） */
export async function login4399WithPassword(opts: Login4399Options): Promise<SauthJson> {
  const f = (opts.fetchImpl || fetch) as FetchLike;
  const username = String(opts.username || "").trim();
  const password = String(opts.password || "");
  if (!username || !password) throw new Error("请填写 4399 账号和密码");
  const usession = randomUUIDish().replace(/-/g, "");
  const form = new URLSearchParams({
    postLoginHandler: "default",
    externalLogin: "qq",
    bizId: "2100001792",
    appId: "kid_wdsj",
    gameId: "wd",
    sec: "1",
    password,
    username,
  });
  if (opts.captchaId && opts.captchaCode) {
    form.set("sessionId", opts.captchaId);
    form.set("inputCaptcha", String(opts.captchaCode).trim());
  }
  const res = await f(`${PTL_HOST}/ptlogin/login.do?v=1`, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: `${PTL_HOST}/ptlogin/`,
      Cookie: `ptusertype=kid_wdsj.4399_login; USESSIONID=${usession}`,
    },
    body: form.toString(),
  });
  const cookies = pickSetCookies(res);
  if (!cookies.Uauth || !cookies.Puser) {
    const text = String(await res.text().catch(() => ""));
    const hint = /验证码|captcha/i.test(text) ? "（需要验证码）" : "";
    throw new Error(`4399 登录失败${hint}：账号密码不对、需要验证码，或 IP 被风控`);
  }
  return complete4399Login(cookies, opts);
}

/** 用已有的 4399 cookie（Uauth/Puser）直接换 sauth */
export async function login4399WithCookie(
  cookie: string,
  opts: { fetchImpl?: FetchLike; udid?: string; deviceid?: string } = {}
): Promise<SauthJson> {
  const cookies = parse4399Cookie(cookie);
  if (!cookies.Uauth || !cookies.Puser) {
    throw new Error("4399 cookie 里缺少 Uauth / Puser（请从已登录 4399 的浏览器里复制完整 cookie）");
  }
  return complete4399Login(cookies, opts);
}

/** 第 3~5 步：checkKidLoginUserCookie → sdk/info → sauth */
async function complete4399Login(
  cookies: Record<string, string>,
  opts: { fetchImpl?: FetchLike; udid?: string; deviceid?: string }
): Promise<SauthJson> {
  const f = (opts.fetchImpl || fetch) as FetchLike;
  const uauth = String(cookies.Uauth || "");
  const randTime = uauth.split("|")[4] || String(Date.now());
  const checkUrl =
    `${PTL_HOST}/ptlogin/checkKidLoginUserCookie.do?appId=kid_wdsj` +
    `&gameUrl=${encodeURIComponent("http://cdn.h5wan.4399sj.com/microterminal-h5-frame?game_id=500352")}` +
    `&rand_time=${encodeURIComponent(randTime)}&nick=null&onLineStart=false&show=1&isCrossDomain=1` +
    `&retUrl=${encodeURIComponent(`${PTL_HOST}/resource/ucenter.html`)}`;
  const checkRes = await f(checkUrl, {
    method: "POST",
    headers: { "User-Agent": UA, Referer: `${PTL_HOST}/`, Cookie: cookieHeader(cookies) },
  });
  const finalUrl = String(checkRes.url || "");
  const qs = finalUrl.includes("?") ? finalUrl.slice(finalUrl.indexOf("?") + 1) : "";
  if (!qs) throw new Error("4399 票据校验失败（没有拿到 queryStr，cookie 可能已过期）");

  const infoRes = await f(`${SDK_INFO_URL}&queryStr=${encodeURIComponent(qs)}`, {
    headers: { "User-Agent": UA },
  });
  const info = await infoRes.json();
  const sdkData = info?.data?.sdk_login_data;
  if (!sdkData) {
    const code = info?.code ?? "?";
    const msg = info?.msg || info?.message || "未知错误";
    throw new Error(`4399 用户信息获取失败（code=${code}：${msg}）`);
  }
  return sdkLoginDataToSauth(String(sdkData), { udid: opts.udid, deviceid: opts.deviceid });
}

/** sauth 对象 → 给 Go 助手用的 json 文本（保持 `{"sauth_json":"..."}` 包裹形式） */
export function wrapSauth(sauth: SauthJson): string {
  return JSON.stringify({ sauth_json: JSON.stringify(sauth) });
}
