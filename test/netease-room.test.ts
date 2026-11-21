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
  joinRealmsByCode,
  listRealms,
  lobbyComponentId,
  parseLocalEndpoint,
  purchaseLobbyComponent,
  peCredential,
  purchaseComponentManually,
  purchasePeRoomComponent,
  resetLobbyCooldown,
  resolvePeLocalRoom,
  resetPeVersionCache,
  resolveLobbyAddress,
  fetchZoneOwnership,
  lobbyChannelOrder,
  credForLobbyChannel,
  hasPeSession,
  isValidPeUserId,
  isPeSessionStaleError,
  isItemNotFoundError,
  isAlreadyOwnedError,
  resolveLobbyRoom,
  resolveRealmsAddress,
  resolveRentalAddress,
  searchLobbyRooms,
  searchLobbyRoomsByResId,
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

test("联机大厅：搜索字段与签名，进房→取地址→退房的顺序", async () => {
  const calls: Array<{ url: string; body: string; token: string }> = [];
  const fakeFetch = (async (url: string, init: any) => {
    calls.push({ url, body: init.body, token: init.headers["user-token"] });
    if (url.includes("/status/MCVersion.json")) {
      return new Response(JSON.stringify({ pe: "1.21.130" }), { status: 200 });
    }
    if (url.endsWith("/online-lobby-room/query/search-by-name")) {
      return new Response(
        JSON.stringify({
          code: 0,
          entities: [
            { entity_id: "888", room_name: "生存大厅", password: 1, member_uids: ["a", "b"], max_count: 10, version: "1.21.120", lobby_manifest_version: "mv1" },
          ],
        }),
        { status: 200 }
      );
    }
    if (url.endsWith("/online-lobby-room-enter")) return new Response(JSON.stringify({ code: 0 }), { status: 200 });
    if (url.endsWith("/online-lobby-game-enter")) {
      return new Response(JSON.stringify({ code: 0, entity: { server_host: "10.0.0.9", server_port: 19132 } }), { status: 200 });
    }
    if (url.endsWith("/leave-room")) return new Response(JSON.stringify({ code: 0 }), { status: 200 });
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;

  resetPeVersionCache();
  const list = await searchLobbyRooms("生存", CRED, { fetchImpl: fakeFetch });
  assert.deepEqual(list, [
    {
      entityId: "888",
      name: "生存大厅",
      hasPwd: true,
      playerCount: 2,
      maxCount: 10,
      version: "1.21.120",
      lobbyManifestVersion: "mv1",
      resId: "",
    },
  ]);
  const searchCall = calls.find((c) => c.url.endsWith("/online-lobby-room/query/search-by-name"))!;
  assert.equal(searchCall.url, "https://g79mclobt.minecraft.cn/online-lobby-room/query/search-by-name");
  assert.equal(searchCall.body, '{"room_name":"生存","res_id":"","version":"1.21.130","offset":0,"length":50}');
  assert.equal(searchCall.token, dynamicToken("/online-lobby-room/query/search-by-name", searchCall.body, CRED.token));

  const resolved = await resolveLobbyRoom("888", "pw", CRED, { fetchImpl: fakeFetch });
  assert.equal(resolved.address.host, "10.0.0.9");
  assert.equal(resolved.address.port, "19132");
  assert.ok(calls.some((c) => c.url.includes("g79apigatewayobt.minecraft.cn/online-lobby-room-enter")));
  const enter = calls.find((c) => c.url.endsWith("/online-lobby-room-enter"))!;
  assert.deepEqual(JSON.parse(enter.body), {
    room_id: "888",
    password: "pw",
    lobby_manifest_version: "mv1",
    check_visibilily: true,
  });
  const game = calls.find((c) => c.url.endsWith("/online-lobby-game-enter"))!;
  assert.equal(game.body, "");
  assert.equal(game.token, dynamicToken("/online-lobby-game-enter", "", CRED.token));
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(calls.some((c) => c.url.endsWith("/leave-room")), "拿到地址后应释放房间席位");
});

test("本地联机：IP:端口 解析与端口校验", () => {
  assert.deepEqual(parseLocalEndpoint({ host: "192.168.1.5", port: "19132" }), { host: "192.168.1.5", port: "19132" });
  assert.deepEqual(parseLocalEndpoint({ keyword: "192.168.1.5:19132" }), { host: "192.168.1.5", port: "19132" });
  assert.deepEqual(parseLocalEndpoint({ keyword: "192.168.1.5" }), { host: "192.168.1.5", port: "19132" });
  assert.deepEqual(parseLocalEndpoint({ keyword: "[::1]:19133" }), { host: "::1", port: "19133" });
  assert.throws(() => parseLocalEndpoint({ host: "", keyword: "" }), /请填写本地联机的主机地址/);
  assert.throws(() => parseLocalEndpoint({ host: "1.2.3.4", port: "70000" }), /端口/);
});

test("山头服：列表 / 邀请码 / sid 地址", async () => {
  const calls: Array<{ url: string; body: string }> = [];
  const fakeFetch = (async (url: string, init: any) => {
    calls.push({ url, body: init.body });
    if (url.endsWith("/domain-server/get-other-servers")) {
      return new Response(JSON.stringify({ code: 0, entities: [{ sid: "sid1", name: "山头", user_id: "u", user_name: "服主", status: 1 }] }), { status: 200 });
    }
    if (url.endsWith("/domain-server/join-server-with-invite-code")) return new Response(JSON.stringify({ code: 0 }), { status: 200 });
    if (url.endsWith("/domain-server/req-enter-domain-server")) {
      return new Response(JSON.stringify({ code: 0, entity: { server_host: "1.2.3.4", server_port: 19132 } }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;

  const list = await listRealms(CRED, { fetchImpl: fakeFetch });
  assert.deepEqual(list, [{ sid: "sid1", name: "山头", userId: "u", userName: "服主", status: 1 }]);
  assert.equal(calls[0].url, "https://g79mclobt.minecraft.cn/domain-server/get-other-servers");
  assert.equal(calls[0].body, "{}");

  await joinRealmsByCode("abc", CRED, { fetchImpl: fakeFetch });
  assert.equal(calls[1].body, '{"code":"abc"}');
  const addr = await resolveRealmsAddress("sid1", CRED, { fetchImpl: fakeFetch });
  assert.deepEqual(addr, { host: "1.2.3.4", port: "19132" });
  assert.equal(calls[2].body, '{"sid":"sid1"}');
});

test("联机大厅：501 不再自动领组件，直接给出组件 ID", async () => {
  const calls: Array<{ url: string; body: string }> = [];
  const fakeFetch = (async (url: string, init: any) => {
    calls.push({ url, body: init.body });
    if (url.includes("/status/MCVersion.json")) {
      return new Response(JSON.stringify({ pe: "1.21.130" }), { status: 200 });
    }
    if (url.endsWith("/online-lobby-room/query/search-by-name")) {
      return new Response(
        JSON.stringify({
          code: 0,
          entities: [
            {
              entity_id: "999",
              room_name: "模组生存",
              password: 0,
              member_uids: ["a"],
              max_count: 10,
              version: "1.21.120",
              lobby_manifest_version: "mv2",
              res_id: "mod-1",
            },
          ],
        }),
        { status: 200 }
      );
    }
    if (url.endsWith("/online-lobby-room-enter")) {
      return new Response(JSON.stringify({ code: 501, message: "物品还未获得" }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;

  resetPeVersionCache();
  const list = await searchLobbyRooms("模组", CRED, { fetchImpl: fakeFetch });
  assert.equal(list[0].resId, "mod-1");

  await assert.rejects(() => resolveLobbyRoom("999", "", CRED, { fetchImpl: fakeFetch }), /组件 ID：mod-1/);
  const enter = calls.find((c) => c.url.endsWith("/online-lobby-room-enter"))!;
  assert.deepEqual(JSON.parse(enter.body), {
    room_id: "999",
    password: "",
    lobby_manifest_version: "mv2",
    check_visibilily: true,
    res_id: "mod-1",
  });
  // 自动领取已经去掉了：501 之后不该再打购买接口
  assert.ok(!calls.some((c) => c.url.endsWith("/pe-purchase-item/") || c.url.endsWith("/user-item-purchase")));
});


test("本地联机：501 不自动领组件，直接提示组件 ID", async () => {
  const calls: Array<{ url: string; body: string }> = [];
  const fakeFetch = (async (url: string, init: any) => {
    calls.push({ url, body: init.body });
    if (url.includes("/status/MCVersion.json")) {
      return new Response(JSON.stringify({ pe: "1.21.130" }), { status: 200 });
    }
    if (url.endsWith("/online-lobby-room-enter")) {
      return new Response(JSON.stringify({ code: 501, message: "物品还未获得" }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;

  await assert.rejects(() => resolvePeLocalRoom("660238", "pw", CRED, { fetchImpl: fakeFetch }), /组件 ID：660238/);
  const enter = calls.find((c) => c.url.endsWith("/online-lobby-room-enter"))!;
  assert.deepEqual(JSON.parse(enter.body), {
    room_id: "660238",
    password: "pw",
    lobby_manifest_version: "",
    check_visibilily: true,
  });
  assert.ok(!calls.some((c) => c.url.endsWith("/pe-purchase-item/") || c.url.endsWith("/user-item-purchase")));
  assert.ok(!calls.some((c) => c.url.endsWith("/online-lobby-game-enter")), "501 之后不该偷偷取地址");
});

test("联机大厅：501 之后不偷偷取地址", async () => {
  let gameEnter = 0;
  const fakeFetch = (async (url: string) => {
    if (url.endsWith("/online-lobby-room-enter")) {
      return new Response(JSON.stringify({ code: 501, message: "物品还未获得" }), { status: 200 });
    }
    if (url.endsWith("/online-lobby-game-enter")) {
      gameEnter++;
      return new Response(JSON.stringify({ code: 0, entity: { server_host: "10.0.0.5", server_port: 19132 } }), {
        status: 200,
      });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  const room = {
    entityId: "4691874405775460100",
    name: "46374",
    hasPwd: false,
    playerCount: 0,
    maxCount: 0,
    version: "",
    lobbyManifestVersion: "",
    resId: "4670652341704101578",
  };
  await assert.rejects(() => resolveLobbyAddress(room, "", CRED, { fetchImpl: fakeFetch }), /组件 ID：4670652341704101578/);
  assert.equal(gameEnter, 0);
});

test("本地联机：非 501 的进房失败带出网易原始 code/message", async () => {
  const fakeFetch = (async (url: string) => {
    if (url.includes("/status/MCVersion.json")) {
      return new Response(JSON.stringify({ pe: "1.21.130" }), { status: 200 });
    }
    if (url.endsWith("/online-lobby-room-enter")) {
      return new Response(JSON.stringify({ code: 404, message: "房间不存在" }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  await assert.rejects(() => resolvePeLocalRoom("660238", "", CRED, { fetchImpl: fakeFetch }), /房间不存在/);
});

test("联机大厅：领到组件后正常进房取地址（手动领取后的路径）", async () => {
  const calls: Array<{ url: string; body: string }> = [];
  const fakeFetch = (async (url: string, init: any) => {
    calls.push({ url, body: init.body });
    if (url.endsWith("/online-lobby-room-enter")) return new Response(JSON.stringify({ code: 0 }), { status: 200 });
    if (url.endsWith("/online-lobby-game-enter")) {
      return new Response(JSON.stringify({ code: 0, entity: { server_host: "10.0.0.7", server_port: 19132 } }), {
        status: 200,
      });
    }
    if (url.endsWith("/leave-room")) return new Response(JSON.stringify({ code: 0 }), { status: 200 });
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;

  const room = {
    entityId: "888",
    name: "模组大厅",
    hasPwd: false,
    playerCount: 1,
    maxCount: 10,
    version: "1.21.120",
    lobbyManifestVersion: "mv1",
    resId: "mod-9",
  };
  const address = await resolveLobbyAddress(room, "", CRED, { fetchImpl: fakeFetch });
  assert.deepEqual(address, { host: "10.0.0.7", port: "19132" });
  assert.ok(!calls.some((c) => c.url.endsWith("/pe-purchase-item/")));
});

test("联机大厅：直接贴 entityId 时跳过搜索，直接进房", async () => {
  const calls: string[] = [];
  const fakeFetch = (async (url: string) => {
    calls.push(url);
    if (url.endsWith("/online-lobby-room-enter")) return new Response(JSON.stringify({ code: 0 }), { status: 200 });
    if (url.endsWith("/online-lobby-game-enter")) {
      return new Response(JSON.stringify({ code: 0, entity: { server_host: "10.0.0.6", server_port: 19132 } }), {
        status: 200,
      });
    }
    if (url.endsWith("/leave-room")) return new Response(JSON.stringify({ code: 0 }), { status: 200 });
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;

  const resolved = await resolveLobbyRoom("4691876429262706557", "", CRED, { fetchImpl: fakeFetch });
  assert.equal(resolved.server.entityId, "4691876429262706557");
  assert.equal(resolved.address.host, "10.0.0.6");
  assert.ok(!calls.some((u) => u.includes("/query/search-by-name")), "长 entityId 不应再走搜索");
});

test("联机大厅：组件 ID 回退顺序 res_id → 数字房间号 → entityId", () => {
  const base = {
    entityId: "4691876870081679726",
    name: "42363",
    hasPwd: false,
    playerCount: 0,
    maxCount: 0,
    version: "",
    lobbyManifestVersion: "",
    resId: "",
  };
  assert.equal(lobbyComponentId(base), "42363");
  assert.equal(lobbyComponentId({ ...base, resId: "mod-9" }), "mod-9");
  assert.equal(lobbyComponentId({ ...base, name: "模组房" }), "4691876870081679726");
});

test("PE 通道凭据：有 peToken 用 PE 账号，没有就退回 PC", () => {
  assert.deepEqual(peCredential(CRED), CRED);
  assert.deepEqual(peCredential({ ...CRED, peUserId: "987654321", peToken: "pe-token" }), {
    userId: "987654321",
    token: "pe-token",
  });
  // 只有 peUserId 没有 token 时不能切成半套凭据
  assert.deepEqual(peCredential({ ...CRED, peUserId: "987654321" }), CRED);
  // pe_entity_id=0 是 PE 认证失败留下的残渣：不能拿它配 PE token 去请求
  assert.deepEqual(peCredential({ ...CRED, peUserId: "0", peToken: "pe-token" }), CRED);
  assert.deepEqual(peCredential({ ...CRED, peUserId: "", peToken: "pe-token" }), CRED);
  assert.equal(hasPeSession({ ...CRED, peUserId: "0", peToken: "pe-token" }), false);
  assert.equal(hasPeSession({ ...CRED, peUserId: "3102995735", peToken: "pe-token" }), true);
});

test("PE 登录态：购买与进房都用 PE 通道的 user-id / user-token", async () => {
  const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
  const fakeFetch = (async (url: string, init: any) => {
    calls.push({ url, body: init.body, headers: init.headers as Record<string, string> });
    if (url.includes("/status/MCVersion.json")) {
      return new Response(JSON.stringify({ pe: "1.21.130" }), { status: 200 });
    }
    if (url.endsWith("/online-lobby-room-enter")) {
      return new Response(JSON.stringify({ code: 0 }), { status: 200 });
    }
    if (url.endsWith("/pe-purchase-item/")) return new Response(JSON.stringify({ code: 0 }), { status: 200 });
    if (url.endsWith("/online-lobby-game-enter")) {
      return new Response(JSON.stringify({ code: 0, entity: { server_host: "10.0.0.9", server_port: 19132 } }), {
        status: 200,
      });
    }
    if (url.endsWith("/leave-room")) return new Response(JSON.stringify({ code: 0 }), { status: 200 });
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;

  const peCred = { ...CRED, peUserId: "987654321", peToken: "pe-token-1234" };
  await purchasePeRoomComponent("4674293883787290", peCred, { fetchImpl: fakeFetch });
  const pe = calls.find((c) => c.url.endsWith("/pe-purchase-item/"))!;
  assert.equal(pe.headers["user-id"], "987654321");

  const address = await resolvePeLocalRoom("660238", "", peCred, { fetchImpl: fakeFetch });
  assert.deepEqual(address, { host: "10.0.0.9", port: "19132" });
  // 进房也必须用 PE entity：联机专区的归属记在 PE 账号上，PC uid 进同一间房仍回 501
  const enter = calls.find((c) => c.url.endsWith("/online-lobby-room-enter"))!;
  assert.equal(enter.headers["user-id"], "987654321");
  // 取地址/退房跟着进房成功的通道走
  const game = calls.find((c) => c.url.endsWith("/online-lobby-game-enter"))!;
  assert.equal(game.headers["user-id"], "987654321");
});

test("联机大厅：没有 PE token 时退回 PC 通道（老账号）", async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fakeFetch = (async (url: string, init: any) => {
    calls.push({ url, headers: init.headers as Record<string, string> });
    if (url.endsWith("/online-lobby-room-enter")) return new Response(JSON.stringify({ code: 0 }), { status: 200 });
    if (url.endsWith("/online-lobby-game-enter")) {
      return new Response(JSON.stringify({ code: 0, entity: { server_host: "h", server_port: 1 } }), { status: 200 });
    }
    if (url.endsWith("/leave-room")) return new Response(JSON.stringify({ code: 0 }), { status: 200 });
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  const room = {
    entityId: "4691878942147351937",
    name: "72563",
    hasPwd: false,
    playerCount: 0,
    maxCount: 0,
    version: "",
    lobbyManifestVersion: "mv",
    resId: "4659475350398889607",
  };
  await resolveLobbyAddress(room, "", CRED, { fetchImpl: fakeFetch });
  const enter = calls.find((c) => c.url.endsWith("/online-lobby-room-enter"))!;
  assert.equal(enter.headers["user-id"], CRED.userId);
});

test("联机大厅：PE 回 501 后换 PC 通道再试一次，PC 通就拿 PC 的地址", async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fakeFetch = (async (url: string, init: any) => {
    const userId = (init.headers as Record<string, string>)["user-id"];
    calls.push({ url, headers: init.headers as Record<string, string> });
    if (url.endsWith("/online-lobby-room-enter")) {
      // PE（PE entity）没领这个专区 → 501；PC 通道通
      return new Response(
        JSON.stringify(userId === "987654321" ? { code: 501, message: "物品还未获得" } : { code: 0 }),
        { status: 200 }
      );
    }
    if (url.endsWith("/online-lobby-game-enter")) {
      return new Response(JSON.stringify({ code: 0, entity: { server_host: "10.1.1.1", server_port: 20000 } }), {
        status: 200,
      });
    }
    if (url.endsWith("/leave-room")) return new Response(JSON.stringify({ code: 0 }), { status: 200 });
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  resetLobbyCooldown();
  const room = {
    entityId: "888",
    name: "大厅房",
    hasPwd: false,
    playerCount: 0,
    maxCount: 0,
    version: "",
    lobbyManifestVersion: "",
    resId: "",
  };
  const peCred = { ...CRED, peUserId: "987654321", peToken: "pe-token-1234" };
  const address = await resolveLobbyAddress(room, "", peCred, { fetchImpl: fakeFetch });
  assert.deepEqual(address, { host: "10.1.1.1", port: "20000" });
  const enters = calls.filter((c) => c.url.endsWith("/online-lobby-room-enter"));
  assert.equal(enters.length, 2, "PE 501 之后应该用 PC 再试一次");
  assert.equal(enters[0].headers["user-id"], "987654321");
  assert.equal(enters[1].headers["user-id"], CRED.userId);
  // 取地址用的是成功那一套（PC）
  const game = calls.find((c) => c.url.endsWith("/online-lobby-game-enter"))!;
  assert.equal(game.headers["user-id"], CRED.userId);
});

test("联机大厅：PE 购买接口参数错误时回退 PC 购买接口", async () => {
  const calls: Array<{ url: string; body: string }> = [];
  const fakeFetch = (async (url: string, init: any) => {
    calls.push({ url, body: init.body });
    if (url.endsWith("/pe-purchase-item/")) {
      return new Response(JSON.stringify({ code: 400, message: "参数错误" }), { status: 200 });
    }
    if (url.endsWith("/user-item-purchase")) return new Response(JSON.stringify({ code: 0 }), { status: 200 });
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;

  await purchasePeRoomComponent("4674293883787290", CRED, { fetchImpl: fakeFetch });
  assert.ok(calls.some((c) => c.url.endsWith("/pe-purchase-item/")));
  const pc = calls.find((c) => c.url.endsWith("/user-item-purchase"))!;
  assert.match(pc.url, /x19apigatewayobt\.nie\.netease\.com/);
  assert.equal(JSON.parse(pc.body).item_id, "4674293883787290");
  assert.equal(JSON.parse(pc.body).user_id, CRED.userId);
});

test("联机大厅：领取组件按 res_id 优先，PC 接口先试", async () => {
  const calls: Array<{ url: string; body: string }> = [];
  const fakeFetch = (async (url: string, init: any) => {
    calls.push({ url, body: init.body });
    if (url.endsWith("/user-item-purchase")) {
      const id = JSON.parse(init.body).item_id;
      // 只有真正的 res_id 能领到；房间号一定失败
      return new Response(
        JSON.stringify(String(id) === "4674293883787290" ? { code: 0 } : { code: 404, message: "目标找不到" }),
        { status: 200 }
      );
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  const room = {
    entityId: "4691876702188070422",
    name: "56320",
    hasPwd: false,
    playerCount: 0,
    maxCount: 0,
    version: "",
    lobbyManifestVersion: "",
    resId: "4674293883787290",
  };
  const used = await purchaseLobbyComponent(room, CRED, { fetchImpl: fakeFetch });
  assert.equal(used, "4674293883787290");
  assert.equal(JSON.parse(calls[0].body).item_id, "4674293883787290");
  assert.match(calls[0].url, /x19apigatewayobt\.nie\.netease\.com/);
  // 房间号不是组件 ID：成功领到之后不该再拿它去打接口
  assert.ok(!calls.some((c) => String(JSON.parse(c.body).item_id) === "56320"));
});

test("PE 回「另一处登录」= PE token 被顶掉：只打一次 PE 并抛出可识别的失效错误", async () => {
  const calls: Array<{ url: string; body: string }> = [];
  const fakeFetch = (async (url: string, init: any) => {
    calls.push({ url, body: init.body });
    if (url.endsWith("/user-item-purchase")) {
      return new Response(JSON.stringify({ code: 404, message: "目标找不到" }), { status: 200 });
    }
    if (url.endsWith("/pe-purchase-item/")) {
      return new Response(JSON.stringify({ code: 1001, message: "您的帐号在另一处登录" }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  const room = {
    entityId: "4691876702188070422",
    name: "56320",
    hasPwd: false,
    playerCount: 0,
    maxCount: 0,
    version: "",
    lobbyManifestVersion: "",
    resId: "4674293883787290",
  };
  const peCred = { ...CRED, peUserId: "987654321", peToken: "pe-token-1234" };
  await assert.rejects(
    () => purchaseLobbyComponent(room, peCred, { fetchImpl: fakeFetch }),
    (e: any) => isPeSessionStaleError(e)
  );
  // 失效时立刻停手：不换候选 ID，也不去 PC 商城白打一次
  assert.equal(calls.filter((c) => c.url.endsWith("/pe-purchase-item/")).length, 1);
  assert.equal(calls.filter((c) => c.url.endsWith("/user-item-purchase")).length, 0);
});

test("手动领取：先走 PE 商城（联机专区是 PE 商品），PC 只是退路", async () => {
  const calls: Array<{ url: string; body: string }> = [];
  const fakeFetch = (async (url: string, init: any) => {
    calls.push({ url, body: init.body });
    if (url.endsWith("/user-item-purchase")) {
      return new Response(JSON.stringify({ code: 404, message: "目标找不到" }), { status: 200 });
    }
    if (url.endsWith("/pe-purchase-item/")) return new Response(JSON.stringify({ code: 0 }), { status: 200 });
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  resetLobbyCooldown();
  // 没有 PE token 时只打 PC 商城：PE 接口没有 PE token 一定回「参数错误」，白打一次没意义
  await assert.rejects(
    () => purchaseComponentManually("4670652341704101578", CRED, { fetchImpl: fakeFetch }),
    /PC 商城目标找不到/
  );
  resetLobbyCooldown();
  assert.equal(JSON.parse(calls[0].body).item_id, "4670652341704101578");
  assert.equal(calls.length, 1);
  assert.ok(!calls.some((c) => c.url.endsWith("/pe-purchase-item/")));
});

test("联机大厅：快速匹配过于频繁时进入冷却，不继续打接口", async () => {
  resetLobbyCooldown();
  let calls = 0;
  const fakeFetch = (async () => {
    calls++;
    return new Response(JSON.stringify({ code: 429, message: "快速匹配过于频繁，请稍后重试" }), { status: 200 });
  }) as unknown as typeof fetch;
  const room = {
    entityId: "1",
    name: "测试房",
    hasPwd: false,
    playerCount: 0,
    maxCount: 0,
    version: "",
    lobbyManifestVersion: "",
    resId: "",
  };
  await assert.rejects(() => resolveLobbyAddress(room, "", CRED, { fetchImpl: fakeFetch }), /频繁/);
  const before = calls;
  await assert.rejects(() => resolveLobbyAddress(room, "", CRED, { fetchImpl: fakeFetch }), /操作过于频繁/);
  assert.equal(calls, before, "冷却期内不应再请求网易");
  resetLobbyCooldown();
});

test("购买接口频繁后进入独立冷却，不再打购买接口", async () => {
  resetLobbyCooldown();
  let calls = 0;
  const fakeFetch = (async (url: string) => {
    calls++;
    if (url.endsWith("/pe-purchase-item/")) {
      return new Response(JSON.stringify({ code: 400, message: "参数错误" }), { status: 200 });
    }
    if (url.endsWith("/user-item-purchase")) {
      return new Response(JSON.stringify({ code: 429, message: "购买太频繁，请稍后再试" }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  const room = {
    entityId: "1",
    name: "93463",
    hasPwd: false,
    playerCount: 0,
    maxCount: 0,
    version: "",
    lobbyManifestVersion: "",
    resId: "4690399271113179886",
  };
  await assert.rejects(() => purchaseLobbyComponent(room, CRED, { fetchImpl: fakeFetch }), /频繁/);
  const before = calls;
  await assert.rejects(() => purchaseLobbyComponent(room, CRED, { fetchImpl: fakeFetch }), /购买接口被限流/);
  assert.equal(calls, before, "购买冷却期内不应再请求");
  resetLobbyCooldown();
});

// ============================================================
// 联机专区组件领取：这条链路的结论都来自 2026-11-15 的线上实测
// （uid 955512087 / PE entity 3102995735，房间 72563 → res_id 4659475350398889607）
// ============================================================

test("联机专区是 PE 商城商品：归属查询走 channel_id=5 + g79apigateway", async () => {
  const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
  const fakeFetch = (async (url: string, init: any) => {
    calls.push({ url, body: init.body, headers: init.headers as Record<string, string> });
    return new Response(
      JSON.stringify({
        code: 0,
        entities: [
          { item_id: "4659475350398889607", channel_id: "5", buy_state: 0 },
          { item_id: "4688187130037072536", channel_id: "5", buy_state: 1 },
        ],
      }),
      { status: 200 }
    );
  }) as unknown as typeof fetch;
  const peCred = { ...CRED, peUserId: "3102995735", peToken: "pe-token-1234" };
  const owned = await fetchZoneOwnership(["4659475350398889607", "4688187130037072536", "999"], peCred, {
    fetchImpl: fakeFetch,
  });
  assert.equal(owned.get("4659475350398889607"), false);
  assert.equal(owned.get("4688187130037072536"), true);
  // 网易没返回的 ID 视为未拥有
  assert.equal(owned.get("999"), false);
  assert.equal(calls[0].url, "https://g79apigatewayobt.minecraft.cn/item-channel/query/search-item-channel-list-by-id");
  assert.deepEqual(JSON.parse(calls[0].body), {
    channel_id: 5,
    item_id_list: ["4659475350398889607", "4688187130037072536", "999"],
  });
  // PC 商城问的是 channel_id=11 + x19apigateway（VQ GetZoneImagesAsync 的写法）
  await fetchZoneOwnership(["4659475350398889607"], CRED, { fetchImpl: fakeFetch, channelId: 11 });
  const pc = calls[1];
  assert.equal(pc.url, "https://x19apigatewayobt.nie.netease.com/item-channel/query/search-item-channel-list-by-id");
  assert.equal(JSON.parse(pc.body).channel_id, 11);
});

test("手动领取：有 PE token 就只打 PE 商城一个请求（不重复下单）", async () => {
  resetLobbyCooldown();
  const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
  const fakeFetch = (async (url: string, init: any) => {
    calls.push({ url, body: init.body, headers: init.headers as Record<string, string> });
    return new Response(JSON.stringify({ code: 0, entity: { entity_id: "4691879791582856898", buy_type: 0 } }), {
      status: 200,
    });
  }) as unknown as typeof fetch;
  const peCred = { ...CRED, peUserId: "3102995735", peToken: "pe-token-1234" };
  const out = await purchaseComponentManually("4659475350398889607", peCred, { fetchImpl: fakeFetch });
  assert.deepEqual(out, { channel: "pe", itemId: "4659475350398889607", alreadyOwned: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://g79mclobt.minecraft.cn/pe-purchase-item/");
  assert.equal(calls[0].headers["user-id"], "3102995735");
  // item_id 必须是 JSON 字符串（VQ 用 JsonConvert.ToString；发数字被判「参数错误」）
  assert.equal(JSON.parse(calls[0].body).item_id, "4659475350398889607");
  assert.equal(JSON.parse(calls[0].body).expertcomment_info.buy_path, "首页-联机大厅-详情页:4659475350398889607");
});

test("手动领取：502「物品已经获得」等价成功，不再换通道重复下单", async () => {
  resetLobbyCooldown();
  const calls: string[] = [];
  const fakeFetch = (async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify({ code: 502, message: "物品已经获得" }), { status: 200 });
  }) as unknown as typeof fetch;
  const peCred = { ...CRED, peUserId: "3102995735", peToken: "pe-token-1234" };
  const out = await purchaseComponentManually("4659475350398889607", peCred, { fetchImpl: fakeFetch });
  assert.equal(out.alreadyOwned, true);
  assert.equal(out.channel, "pe");
  assert.equal(calls.length, 1);
});

test("手动领取：PE 回 16「目标找不到」才换 PC 商城，各打一次", async () => {
  resetLobbyCooldown();
  const calls: string[] = [];
  const fakeFetch = (async (url: string) => {
    calls.push(url);
    if (url.endsWith("/pe-purchase-item/")) {
      return new Response(JSON.stringify({ code: 16, message: "目标找不到" }), { status: 200 });
    }
    return new Response(JSON.stringify({ code: 0 }), { status: 200 });
  }) as unknown as typeof fetch;
  const peCred = { ...CRED, peUserId: "3102995735", peToken: "pe-token-1234" };
  const out = await purchaseComponentManually("4659475350398889607", peCred, { fetchImpl: fakeFetch });
  assert.equal(out.channel, "pc");
  assert.equal(calls.length, 2);
  assert.ok(calls[0].endsWith("/pe-purchase-item/"));
  assert.ok(calls[1].endsWith("/user-item-purchase"));
});

test("手动领取：两个通道都「目标找不到」时报错带出两个通道的原因", async () => {
  resetLobbyCooldown();
  const fakeFetch = (async (url: string) => {
    if (url.endsWith("/pe-purchase-item/") || url.endsWith("/user-item-purchase")) {
      return new Response(JSON.stringify({ code: 16, message: "目标找不到" }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  const peCred = { ...CRED, peUserId: "3102995735", peToken: "pe-token-1234" };
  await assert.rejects(
    () => purchaseComponentManually("72563", peCred, { fetchImpl: fakeFetch }),
    /PE 商城目标找不到；PC 商城目标找不到/
  );
});

test("错误分类：16=没这个商品，502=已拥有，「另一处登录」=PE token 失效", () => {
  assert.ok(isItemNotFoundError({ code: 16, message: "目标找不到" }));
  assert.ok(isItemNotFoundError(new Error("目标找不到")));
  assert.ok(isAlreadyOwnedError({ code: 502 }));
  assert.ok(isPeSessionStaleError({ code: "1001", message: "您的帐号在另一处登录" }));
  assert.ok(!isPeSessionStaleError(new Error("物品还未获得")));
});

test("通道顺序：有 PE token 先 PE，没有就只用 PC", () => {
  assert.deepEqual(lobbyChannelOrder(CRED), ["pc"]);
  const peCred = { ...CRED, peUserId: "3102995735", peToken: "pe-token-1234" };
  assert.deepEqual(lobbyChannelOrder(peCred), ["pe", "pc"]);
  assert.deepEqual(credForLobbyChannel(peCred, "pe"), { userId: "3102995735", token: "pe-token-1234" });
  assert.deepEqual(credForLobbyChannel(peCred, "pc"), { userId: CRED.userId, token: CRED.token });
});

test("联机大厅：两个通道都 501 时才报 501，且不偷偷取地址", async () => {
  const calls: string[] = [];
  const fakeFetch = (async (url: string) => {
    calls.push(url);
    if (url.endsWith("/online-lobby-room-enter")) {
      return new Response(JSON.stringify({ code: 501, message: "物品还未获得", entity: null }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  resetLobbyCooldown();
  const room = {
    entityId: "4691878942147351937",
    name: "72563",
    hasPwd: false,
    playerCount: 0,
    maxCount: 0,
    version: "",
    lobbyManifestVersion: "mv",
    resId: "4659475350398889607",
  };
  const peCred = { ...CRED, peUserId: "3102995735", peToken: "pe-token-1234" };
  await assert.rejects(() => resolveLobbyAddress(room, "", peCred, { fetchImpl: fakeFetch }), /组件 ID：4659475350398889607/);
  assert.equal(calls.filter((u) => u.endsWith("/online-lobby-room-enter")).length, 2);
  assert.equal(calls.filter((u) => u.endsWith("/online-lobby-game-enter")).length, 0);
});

test("按联机专区组件 ID 列房间：走 list-room-by-res-id", async () => {
  resetPeVersionCache();
  const calls: Array<{ url: string; body: string }> = [];
  const fakeFetch = (async (url: string, init: any) => {
    calls.push({ url, body: init.body });
    if (url.includes("/status/MCVersion.json")) {
      return new Response(JSON.stringify({ pe: "1.21.130" }), { status: 200 });
    }
    if (url.endsWith("/online-lobby-room/query/list-room-by-res-id")) {
      return new Response(
        JSON.stringify({
          code: 0,
          entities: [
            {
              entity_id: "4691878942147351937",
              room_name: "72563",
              password: 0,
              member_uids: ["a", "b"],
              max_count: 10,
              version: "1.21.120",
              lobby_manifest_version: "mv",
              res_id: "4659475350398889607",
            },
          ],
        }),
        { status: 200 }
      );
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;

  const list = await searchLobbyRoomsByResId("4659475350398889607", CRED, { fetchImpl: fakeFetch });
  assert.equal(list.length, 1);
  assert.equal(list[0].entityId, "4691878942147351937");
  assert.equal(list[0].resId, "4659475350398889607");
  assert.equal(list[0].playerCount, 2);
  const req = calls.find((c) => c.url.endsWith("/list-room-by-res-id"))!;
  assert.match(req.url, /g79apigatewayobt\.minecraft\.cn/);
  const body = JSON.parse(req.body);
  assert.equal(body.res_id, "4659475350398889607");
  assert.equal(body.length, 200);
  assert.equal(body.with_friend, true);
});

test("PE 领取：第一个域名网络失败时换 g79apigateway 再试", async () => {
  const hosts: string[] = [];
  const fakeFetch = (async (url: string) => {
    hosts.push(new URL(url).host);
    if (hosts.length === 1) throw new TypeError("fetch failed");
    return new Response(JSON.stringify({ code: 0 }), { status: 200 });
  }) as unknown as typeof fetch;
  const out = await purchasePeRoomComponent("4659475350398889607", CRED, { fetchImpl: fakeFetch });
  assert.equal(out.alreadyOwned, false);
  assert.deepEqual(hosts, ["g79mclobt.minecraft.cn", "g79apigatewayobt.minecraft.cn"]);
});

test("PE 领取：目标找不到（16）不换域名，直接报错", async () => {
  let n = 0;
  const fakeFetch = (async () => {
    n++;
    return new Response(JSON.stringify({ code: 16, message: "目标找不到" }), { status: 200 });
  }) as unknown as typeof fetch;
  resetLobbyCooldown();
  await assert.rejects(() => purchasePeRoomComponent("123456789", CRED, { fetchImpl: fakeFetch }), /目标找不到/);
  assert.equal(n, 1, "16 不该再打第二个域名");
});
