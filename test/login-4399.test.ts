/**
 * 4399 渠道登录 / cookie 登录的离线回归。
 *
 * 只测纯逻辑与协议拼装（不联网）：
 *   · cookie 串解析、输入类型识别
 *   · sdk_login_data → 网易 sauth 的字段映射（gameid/login_channel/4399pc…）
 *   · 用假 fetch 走一遍「cookie → checkKidLoginUserCookie → sdk/info」的请求序列
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  detectLoginInput,
  login4399WithCookie,
  parse4399Cookie,
  sdkLoginDataToSauth,
} from "../src/login-4399";

test("4399 cookie 解析：支持分号/换行、多余空格、值里带 =", () => {
  const c = parse4399Cookie(" Uauth=abc|123 ; Puser=xx=y ; \n foo=bar ");
  assert.equal(c.Uauth, "abc|123");
  assert.equal(c.Puser, "xx=y");
  assert.equal(c.foo, "bar");
  assert.deepEqual(parse4399Cookie(""), {});
});

test("输入类型识别：网易 sauth / 4399 cookie / 空 / 认不出", () => {
  assert.equal(detectLoginInput(""), "empty");
  assert.equal(detectLoginInput('{"sauth_json":"{}"}'), "sauth");
  assert.equal(detectLoginInput('{"gameid":"x19","sdkuid":"1","sessionid":"2"}'), "sauth");
  assert.equal(detectLoginInput("Uauth=a; Puser=b"), "cookie4399");
  assert.equal(detectLoginInput("hello world"), "unknown");
  assert.equal(detectLoginInput("{bad json"), "unknown");
});

test("sdk_login_data → sauth：渠道字段与 uid/token 映射正确", () => {
  const sauth = sdkLoginDataToSauth("uid=U123&token=T456&username=player&time=1700000000", {
    udid: "UDID1",
    deviceid: "DEV1",
    clientLoginSn: "SN1",
  });
  assert.equal(sauth.gameid, "x19");
  assert.equal(sauth.login_channel, "4399pc");
  assert.equal(sauth.app_channel, "4399pc");
  assert.equal(sauth.platform, "pc");
  assert.equal(sauth.sdkuid, "U123");
  assert.equal(sauth.sessionid, "T456");
  assert.equal(sauth.userid, "player");
  assert.equal(sauth.timestamp, "1700000000");
  assert.equal(sauth.udid, "UDID1");
  assert.equal(sauth.deviceid, "DEV1");
  assert.equal(sauth.client_login_sn, "SN1");
  assert.equal(JSON.parse(sauth.realname).realname_type, "0");
  assert.equal(JSON.parse(sauth.aim_info).country, "CN");
  assert.throws(() => sdkLoginDataToSauth("uid=&token="), /缺少 uid\/token/);
});

test("cookie 登录：checkKidLoginUserCookie → sdk/info → sauth", async () => {
  const calls: Array<{ url: string; method: string; cookie?: string }> = [];
  const fakeFetch = async (url: string, init: any = {}) => {
    calls.push({ url, method: init.method || "GET", cookie: init.headers?.Cookie });
    if (url.includes("checkKidLoginUserCookie.do")) {
      return {
        url:
          "http://ptlogin.4399.com/ptlogin/checkKidLoginUserCookie.do?queryStr%3DappId%253Dkid_wdsj%2526uid%253DU1",
        headers: {},
        text: async () => "",
      };
    }
    if (url.includes("microgame.5054399.net")) {
      return {
        url,
        headers: {},
        json: async () => ({ code: 100, data: { sdk_login_data: "uid=U1&token=T1&username=张三&time=123" } }),
      };
    }
    throw new Error("unexpected url " + url);
  };
  const sauth = await login4399WithCookie("Uauth=a|b|c|d|1700; Puser=p", { fetchImpl: fakeFetch as any });
  assert.equal(sauth.sdkuid, "U1");
  assert.equal(sauth.sessionid, "T1");
  assert.equal(sauth.userid, "张三");
  assert.match(calls[0].url, /checkKidLoginUserCookie\.do\?appId=kid_wdsj/);
  assert.match(calls[0].url, /rand_time=1700/, "rand_time 取 Uauth 第 5 段");
  assert.equal(calls[0].method, "POST");
  assert.match(String(calls[0].cookie), /Uauth=a\|b\|c\|d\|1700/);
  assert.match(calls[1].url, /sdk\/info/);
  assert.match(calls[1].url, /queryStr=/);
});

test("cookie 登录：cookie 缺字段 / 票据无效时报明确错误", async () => {
  await assert.rejects(() => login4399WithCookie("foo=bar", {} as any), /缺少 Uauth \/ Puser/);
  const fakeFetch = async () => ({ url: "http://ptlogin.4399.com/x", headers: {}, text: async () => "" });
  await assert.rejects(
    () => login4399WithCookie("Uauth=a; Puser=b", { fetchImpl: fakeFetch as any }),
    /没有拿到 queryStr/
  );
});
