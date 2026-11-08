/* ============================================================
 * SnowLuma 风格附加面板（Fatalder 优点移植到 Cubeloom）
 *  - 进服配置：多套网易版房间配置（保存 / 切换 / 删除）
 *  - 任务队列：命令 / 游戏指令 / 等待 / 结构导入 顺序执行
 * 数据保存在浏览器 localStorage；执行调用现有管理端 API。
 * ============================================================ */
(function () {
  "use strict";

  const LS_PROFILES = "cq-profiles-v1";
  const LS_QUEUE = "cq-queue-v1";
  const $ = (id) => document.getElementById(id);

  const load = (k, d) => {
    try { const s = localStorage.getItem(k); return s ? JSON.parse(s) : d; } catch { return d; }
  };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

  const post = async (url, body) => {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body || {}),
      });
      return await r.json().catch(() => ({ ok: false, error: "响应解析失败" }));
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  };

  /* ---------------- 进服配置 ---------------- */
  let profiles = load(LS_PROFILES, []);
  let activeProfile = "";

  function renderProfiles() {
    const box = $("profile-list");
    if (!box) return;
    box.innerHTML = "";
    if (!profiles.length) {
      box.innerHTML = '<div class="sl-empty">还没有进服配置，填好左侧表单后点「保存配置」</div>';
      return;
    }
    profiles.forEach((p) => {
      const el = document.createElement("div");
      el.className = "profile-card" + (p.name === activeProfile ? " active" : "");
      el.innerHTML =
        '<div class="meta"><div class="t"></div><div class="s"></div></div>' +
        '<div class="ops">' +
        '<button class="btn small ghost" data-act="use">使用</button>' +
        '<button class="btn small ghost" data-act="del">删除</button>' +
        "</div>";
      el.querySelector(".t").textContent = p.name;
      el.querySelector(".s").textContent =
        [p.mode, p.room && "房间 " + p.room, p.password ? "已设密码" : "无密码", p.note].filter(Boolean).join(" · ");
      el.querySelector('[data-act="use"]').onclick = () => {
        activeProfile = p.name;
        renderProfiles();
        const text = JSON.stringify({ mode: p.mode, room: p.room, password: p.password }, null, 2);
        navigator.clipboard && navigator.clipboard.writeText(text).catch(() => {});
        toast("已切换到「" + p.name + "」，连接参数已复制到剪贴板");
      };
      el.querySelector('[data-act="del"]').onclick = () => {
        profiles = profiles.filter((x) => x.name !== p.name);
        if (activeProfile === p.name) activeProfile = "";
        save(LS_PROFILES, profiles);
        renderProfiles();
      };
      box.appendChild(el);
    });
  }

  function bindProfileForm() {
    const btn = $("profile-save");
    if (!btn) return;
    btn.onclick = () => {
      const name = ($("pf-name").value || "").trim();
      if (!name) return toast("请填写配置名称", true);
      const item = {
        name,
        mode: $("pf-mode").value,
        room: ($("pf-room").value || "").trim(),
        password: ($("pf-pass").value || "").trim(),
        note: ($("pf-note").value || "").trim(),
        at: Date.now(),
      };
      profiles = profiles.filter((x) => x.name !== name).concat(item);
      save(LS_PROFILES, profiles);
      activeProfile = name;
      renderProfiles();
      toast("配置「" + name + "」已保存");
      $("pf-name").value = "";
    };
  }

  /* ---------------- 任务队列 ---------------- */
  let queue = load(LS_QUEUE, []);
  let running = false;
  let stopFlag = false;

  const TYPE_LABEL = { command: "代码", send: "游戏指令", sleep: "等待", build: "结构导入" };

  function renderQueue() {
    const box = $("queue-list");
    if (!box) return;
    box.innerHTML = "";
    if (!queue.length) {
      box.innerHTML = '<div class="sl-empty">队列为空。添加任务后会按顺序执行</div>';
      updateQueueStat();
      return;
    }
    queue.forEach((t, i) => {
      const el = document.createElement("div");
      el.className = "queue-item" + (t.state === "running" ? " running" : "");
      el.innerHTML =
        '<span class="idx">' + (i + 1) + "</span>" +
        '<div class="meta"><div class="t"></div><div class="s"></div></div>' +
        '<div class="ops">' +
        '<button class="btn small ghost" data-act="del">删除</button>' +
        "</div>";
      el.querySelector(".t").textContent = TYPE_LABEL[t.type] + "：" + (t.text || "").slice(0, 48) + (t.text && t.text.length > 48 ? "…" : "");
      el.querySelector(".s").textContent =
        (t.state === "running" ? "执行中" : t.state === "done" ? "已完成" : t.state === "error" ? "失败：" + (t.error || "") : "待执行");
      el.querySelector('[data-act="del"]').onclick = () => {
        if (running) return toast("正在执行，先停止队列", true);
        queue.splice(i, 1);
        save(LS_QUEUE, queue);
        renderQueue();
      };
      box.appendChild(el);
    });
    updateQueueStat();
  }

  function updateQueueStat() {
    const el = $("queue-stat");
    if (!el) return;
    const done = queue.filter((t) => t.state === "done").length;
    el.textContent = queue.length ? done + " / " + queue.length + " 已完成" : "";
  }

  function toast(msg, bad) {
    const el = $("sl-toast");
    if (!el) { console.log(msg); return; }
    el.textContent = msg;
    el.style.borderColor = bad ? "#c05656" : "var(--sl-accent)";
    el.style.color = bad ? "#f2b8b8" : "var(--sl-fg)";
    el.style.opacity = "1";
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.style.opacity = "0"; }, 2600);
  }

  function bindQueueForm() {
    const add = $("queue-add");
    if (!add) return;
    add.onclick = () => {
      const type = $("q-type").value;
      const text = ($("q-text").value || "").trim();
      if (type !== "build" && !text) return toast("请填写内容", true);
      const item = { type, text, state: "pending" };
      if (type === "sleep") {
        const n = Number(text);
        if (!isFinite(n) || n <= 0) return toast("等待秒数需为正数", true);
        item.text = n + " 秒";
      }
      if (type === "build") {
        const off = Number($("q-offset").value || 0) || 0;
        item.text = "偏移 Y " + off;
        item.offsetY = off;
      }
      queue.push(item);
      save(LS_QUEUE, queue);
      $("q-text").value = "";
      renderQueue();
      toast("已加入队列");
    };
    const clear = $("queue-clear");
    if (clear) clear.onclick = () => {
      if (running) return toast("正在执行，先停止队列", true);
      queue = [];
      save(LS_QUEUE, queue);
      renderQueue();
    };
    const start = $("queue-start");
    if (start) start.onclick = () => runQueue();
    const stop = $("queue-stop");
    if (stop) stop.onclick = () => {
      stopFlag = true;
      toast("将在当前任务结束后停止");
    };
  }

  async function runQueue() {
    if (running) return;
    if (!queue.length) return toast("队列为空", true);
    running = true;
    stopFlag = false;
    for (const item of queue) {
      if (stopFlag) break;
      if (item.state === "done") continue;
      item.state = "running";
      renderQueue();
      let r = { ok: true };
      if (item.type === "sleep") {
        await new Promise((res) => setTimeout(res, Number(item.text) * 1000));
      } else if (item.type === "command") {
        r = await post("/api/command", { code: item.text });
      } else if (item.type === "send") {
        r = await post("/api/send", { command: item.text.replace(/^\//, "") });
      } else if (item.type === "build") {
        r = await post("/api/structure/build", { offsetY: item.offsetY || 0 });
      }
      item.state = r && r.ok ? "done" : "error";
      item.error = r && r.ok ? "" : (r && r.error) || "执行失败";
      renderQueue();
    }
    running = false;
    renderQueue();
    toast(stopFlag ? "队列已停止" : "队列执行完毕");
  }

  /* ---------------- 启动 ---------------- */
  function init() {
    if (!$("profile-list") || !$("queue-list")) return;
    renderProfiles();
    bindProfileForm();
    bindQueueForm();
    renderQueue();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
