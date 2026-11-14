/**
 * 网易账号登录链路（账号 → 房间 → 引擎参数）的离线回归。
 *
 * 动态签名是整条链上唯一"错了也看不出"的东西：错了网易只会回 401/空列表，
 * 所以这里用 Go 版 NeteaseLogin 生成的固定向量锁死算法，避免以后重构悄悄改坏。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildEngineArgs,
  dynamicToken,
  md5TokenBase64,
  pickRentalServer,
  redactEngineArgs,
  resolveRentalAddress,
  searchRentalServers,
  x19Post,
} from "../src/netease-room";

const CRED = { userId: "123456789", token: "abcdef0123456789" };

test("MD5Token = Base64(MD5(token))（引擎 --MD5Token 参数）", () => {
  // 向量来自 Go：base64(md5("abc"))
  assert.equal(md5TokenBase64("abc"), "kAFQmDzST7DWlj99KOF/cg==");
  assert.equal(md5TokenBase64("abcdef0123456789"), "NCZFsZ8/YeNQd9wewCMqxw==");
  assert.equal(md5TokenBase64(""), "");
});

test("X19 动态签名与 Go/VQ 实现逐字节一致", () => {
  const vectors: Array<[string, string, string, string]> = [
    ["token-abc", "/authentication/update", '{"entity_id":123}', "oq9oo3z7fC3rmvo41"],
    [
      "abcdef0123456789",
      "/rental-server/query/search-by-name",
      '{"server_name":"测试服","offset":0,"length":50}',
      "fTzm77rqfLopajTr1",
    ],
    [
      "abcdef0123456789",
      "/rental-server-world-enter/get",
      '{"server_id":"123456789","pwd":""}',
      "IT05rjl4mz5gKLuu1",
    ],
    ["", "/x", "", "K2G6o2i8NXj7oXdg1"],
  ];
  for (const [token, path, body, expected] of vectors) {
    assert.equal(dynamicToken(path, body, token), expected, `${path} ${body}`);
    // 不以 / 开头等价（Go 的 TrimPrefix 行为）
    assert.equal(dynamicToken(path.replace(/^\//, ""), body, token), expected);
  }
  assert.notEqual(dynamicToken("/x", "", "token-abc"), dynamicToken("/x", "", "token-abd"));
});

test("x19Post 带上 user-id / user-token，并且签名用的就是实际发送的 body", async () => {
  let seen: any = null;
  const fakeFetch = (async (url: string, init: any) => {
    seen = { url, init };
    return new Response(JSON.stringify({ code: 0, entities: [] }), { status: 200 });
  }) as unknown as typeof fetch;

  await x19Post("/rental-server/query/search-by-name", '{"server_name":"测试","offset":0,"length":50}', CRED, {
    fetchImpl: fakeFetch,
  });

  assert.equal(seen.url, "https://g79mclobt.minecraft.cn/rental-server/query/search-by-name");
  assert.equal(seen.init.method, "POST");
  assert.equal(seen.init.headers["user-id"], CRED.userId);
  assert.equal(
    seen.init.headers["user-token"],
    dynamicToken("/rental-server/query/search-by-name", seen.init.body, CRED.token)
  );
  assert.equal(seen.init.body, '{"server_name":"测试","offset":0,"length":50}');
});

test("搜索房间：字段归一化（has_pwd 可能是 1 / \"1\" / true）", async () => {
  const fakeFetch = (async () =>
    new Response(
      JSON.stringify({
        code: 0,
        entities: [
          { entity_id: 111, name: "A", has_pwd: 1, player_count: "3", capacity: 10 },
          { entity_id: "222", name: "B", has_pwd: "0" },
        ],
      }),
      { status: 200 }
    )) as unknown as typeof fetch;

  const list = await searchRentalServers("A", CRED, { fetchImpl: fakeFetch });
  assert.deepEqual(list, [
    { entityId: "111", name: "A", hasPwd: true, playerCount: 3, capacity: 10, briefSummary: "" },
    { entityId: "222", name: "B", hasPwd: false, playerCount: 0, capacity: 0, briefSummary: "" },
  ]);
});

test("房间地址：缺 host/port 时报错，不返回半个地址", async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ code: 0, entity: { mcserver_host: "1.2.3.4" } }), { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(() => resolveRentalAddress("111", "", CRED, { fetchImpl: fakeFetch }), /没有返回房间地址/);
});

test("房间选择：完整 ID 优先，唯一结果直接用，多结果要求补全", () => {
  const list = [
    { entityId: "111", name: "A", hasPwd: false, playerCount: 0, capacity: 0, briefSummary: "" },
    { entityId: "222", name: "B", hasPwd: false, playerCount: 0, capacity: 0, briefSummary: "" },
  ];
  assert.equal(pickRentalServer(list, "222").entityId, "222");
  assert.equal(pickRentalServer([list[0]], "A").entityId, "111");
  assert.throws(() => pickRentalServer([], "A"), /没找到房间/);
  assert.throws(() => pickRentalServer(list, "A"), /匹配到 2 个房间/);
});

test("引擎参数：与 VQ 的启动契约一致，且不经过 shell", () => {
  const args = buildEngineArgs({
    userId: "123456789",
    token: "abcdef0123456789",
    entityId: "4654415063569776560",
    host: "10.0.0.2",
    port: 19132,
    displayName: "机主\n名字",
  });
  const get = (k: string) => args[args.indexOf(k) + 1];
  assert.equal(get("--ServerIP"), "10.0.0.2");
  assert.equal(get("--ServerPort"), "19132");
  assert.equal(get("--UserID"), "123456789");
  assert.equal(get("--MD5Token"), "NCZFsZ8/YeNQd9wewCMqxw==");
  assert.equal(get("--NeteaseServerID"), "4654415063569776560:RentalGame");
  assert.equal(get("--AuthServerUrl"), "https://g79authobt.minecraft.cn");
  assert.equal(get("--DisplayName"), "机主 名字");
  assert.ok(args.includes("--g79"));
  assert.ok(args.includes("--logger"));

  const redacted = redactEngineArgs(args);
  assert.equal(redacted[redacted.indexOf("--MD5Token") + 1], "***(24)");
  // 原数组不能被改写
  assert.equal(get("--MD5Token"), "NCZFsZ8/YeNQd9wewCMqxw==");
});

test("引擎参数：缺房间地址 / user_id 直接报错", () => {
  assert.throws(
    () => buildEngineArgs({ userId: "1", token: "t", entityId: "2", host: "", port: "1", displayName: "x" }),
    /缺少房间地址/
  );
  assert.throws(
    () => buildEngineArgs({ userId: "", token: "t", entityId: "2", host: "h", port: "1", displayName: "x" }),
    /缺少 user_id/
  );
});
