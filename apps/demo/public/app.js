const els = {
  state: document.querySelector("#state"),
  link: document.querySelector("#link"),
  core: document.querySelector("#core"),
  session: document.querySelector("#session"),
  turns: document.querySelector("#turns"),
  provider: document.querySelector("#provider"),
  devices: document.querySelector("#devices"),
  quantum: document.querySelector("#quantum"),
  machine: document.querySelector("#machine"),
  lifecycle: document.querySelector("#lifecycle"),
  sources: document.querySelector("#sources"),
  qmeta: document.querySelector("#qmeta"),
  quantumlog: document.querySelector("#quantumlog"),
  checks: document.querySelector("#checks"),
  decohere: document.querySelector("#decohere"),
  paths: document.querySelector("#paths"),
  transcript: document.querySelector("#transcript"),
  verdict: document.querySelector("#verdict"),
  insert: document.querySelector("#insert"),
  eject: document.querySelector("#eject"),
  composer: document.querySelector("#composer"),
  text: document.querySelector("#text"),
  send: document.querySelector("#send"),
  device: document.querySelector("#device"),
};

let ledOn = false;
let busy = false;

const MACHINE = [
  "S0_EJECTED",
  "S1_AUTH",
  "S2_CONVERGE",
  "S3_INSTANTIATED",
  "S4_DECOHERED",
  "S5_RECOVER",
  "SX_REJECTED",
];

const CHECK_STEPS = [
  { name: "结构 + 时效", detail: "schema · expiresAt ≤ 30s" },
  { name: "公钥可达 + 验签", detail: "ed25519 · canonical(body)" },
  { name: "量子权限", detail: "perm.grant · subject / op / resource / 有效期" },
  { name: "本地策略 + 执行", detail: "policy.json allow" },
];

function short(value, head = 10, tail = 6) {
  const text = String(value ?? "");
  if (text.length === 0) return "—";
  if (text.length <= head + tail + 1) return text;
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

function failedStep(reason) {
  if (reason === "E_STALE") return 0;
  if (reason === "E_SIG") return 1;
  if (reason === "E_PERM_UNKNOWN" || reason === "E_PERM_EXPIRED" || reason === "E_OP_NOT_GRANTED") return 2;
  if (reason === "E_POLICY") return 3;
  return 2;
}

function renderMachine(state) {
  els.machine.replaceChildren(
    ...MACHINE.map((name) => {
      const chip = document.createElement("span");
      chip.textContent = name.replace("_", " ");
      chip.dataset.seen = String(state.lifecycle.includes(name));
      chip.dataset.active = String(state.state === name);
      return chip;
    }),
  );
}

function sourceRow(label, ok, lines) {
  const box = document.createElement("div");
  box.className = "source";
  box.dataset.ok = String(ok);
  const head = document.createElement("header");
  const dot = document.createElement("b");
  dot.className = "sdot";
  dot.dataset.ok = String(ok);
  const title = document.createElement("span");
  title.textContent = label;
  head.append(dot, title);
  const body = document.createElement("p");
  body.textContent = lines.filter((line) => line.length > 0).join(" · ");
  box.append(head, body);
  return box;
}

function renderSources(state) {
  const sources = state.sources;
  const byType = Object.entries(sources.quantum.byType)
    .map(([type, count]) => `${type}:${count}`)
    .join(" ");
  const verdict = state.state === "S3_INSTANTIATED"
    ? "已收敛（S3）"
    : state.state === "S5_RECOVER"
      ? "恢复路径已复核（S5）"
      : "未收敛";
  els.sources.replaceChildren(
    sourceRow("A · Agent Core manifest", Boolean(sources.agentCore.coreId), [
      `core ${short(sources.agentCore.coreId)}`,
      `baseline ${sources.agentCore.baseline}`,
      `legalFields ${sources.agentCore.legalFields}`,
      `contributes ${sources.agentCore.contributes.join("/") || "—"}`,
      `signing ${short(sources.agentCore.signingKey)}`,
    ]),
    sourceRow("B · 全局状态量子", sources.quantum.total > 0, [
      `total ${sources.quantum.total}`,
      `本 Core 可达 ${sources.quantum.reachable}`,
      byType || "空",
    ]),
    sourceRow("C · Mobile Suite /iface", sources.mobileSuite.devices.length > 0, [
      `suite ${short(sources.mobileSuite.suiteId)}`,
      `devices ${sources.mobileSuite.devices.join("/") || "—"}`,
      `coreKeys ${sources.mobileSuite.registeredKeys}`,
    ]),
    Object.assign(document.createElement("p"), {
      className: "hint",
      textContent: `当前：${verdict}`,
    }),
  );
}

function renderQuantum(state) {
  els.qmeta.textContent = `共 ${state.quantum} 条 · 只追加 · 每条 digest 串联前一条`;
  if (state.quantumLog.length === 0) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "尚未写入任何条目";
    els.quantumlog.replaceChildren(empty);
    return;
  }
  els.quantumlog.replaceChildren(
    ...state.quantumLog.map((row, index) => {
      const item = document.createElement("div");
      item.className = "qrow";
      item.dataset.latest = String(index === 0);
      const seq = document.createElement("span");
      seq.className = "seq";
      seq.textContent = `#${row.seq}`;
      const body = document.createElement("div");
      const line1 = document.createElement("div");
      line1.className = "line1";
      line1.textContent = `${row.type} · ${row.sourceKind} · ${short(row.sourceId, 8, 4)}`;
      const line2 = document.createElement("div");
      line2.className = "line2";
      line2.textContent = `${row.sensitivity} · keys ${row.keyIds.length} · fields ${row.fields.join(",") || "—"} · ${row.digest}…`;
      body.append(line1, line2);
      item.append(seq, body);
      return item;
    }),
  );
}

function renderChecks(state) {
  const verdict = state.lastVerdict;
  const failed = verdict === null ? null : verdict.ok ? CHECK_STEPS.length : failedStep(verdict.reason);
  const items = CHECK_STEPS.map((step, index) => {
    const item = document.createElement("li");
    const status = verdict === null
      ? "pending"
      : index < failed
        ? "pass"
        : index === failed
          ? "fail"
          : "skip";
    item.dataset.status = status;
    const mark = document.createElement("span");
    mark.className = "mark";
    mark.textContent = status === "pass" ? "✓" : status === "fail" ? "✗" : status === "skip" ? "·" : "○";
    const text = document.createElement("div");
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = step.name;
    const detail = document.createElement("div");
    detail.className = "detail";
    detail.textContent = step.detail;
    text.append(name, detail);
    item.append(mark, text);
    return item;
  });
  const hint = document.createElement("li");
  hint.dataset.status = "note";
  hint.className = "note";
  hint.textContent = verdict === null
    ? "点击「切换 LED」触发一次请求，这里逐步点亮四道校验"
    : verdict.ok
      ? "四步全部通过 → 已执行设备操作"
      : `失败于 ${verdict.reason}，后续步骤未执行`;
  els.checks.replaceChildren(...items, hint);
}

function renderDecohere(state) {
  if (state.decohere === null) {
    els.decohere.dataset.found = "false";
    els.decohere.textContent = "尚未发生（拔卡后可观察 mount 消失 → Embody 退出 → 零写入）";
    return;
  }
  els.decohere.dataset.found = "true";
  const at = new Date(state.decohere.at);
  els.decohere.textContent = `reason ${state.decohere.reason} · lateWrites ${state.decohere.lateWrites} · at ${at.toLocaleTimeString()}`;
}

function renderPaths(state) {
  const rows = [
    ["量子日志", state.paths.quantum],
    ["插卡指针", state.paths.mount],
    ["会话目录", state.paths.sessions],
    ["退相干", state.paths.decohere],
  ];
  els.paths.replaceChildren(
    ...rows.map(([label, value]) => {
      const row = document.createElement("div");
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.textContent = value;
      row.append(dt, dd);
      return row;
    }),
  );
}

async function call(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? "request failed");
  return payload;
}

function render(state) {
  els.state.textContent = state.state;
  els.state.dataset.live = String(state.state.startsWith("S3"));
  els.state.dataset.dead = String(state.phase === "rejected" || state.state === "S4_DECOHERED");
  els.core.textContent = state.coreId ?? "—";
  els.session.textContent = state.session ? `${state.session.sessionId.slice(0, 8)}…` : "—";
  els.session.title = state.session ? state.session.sessionId : "";
  els.turns.textContent = String(state.session ? state.session.turns : 0);
  els.provider.textContent = `${state.provider.name} · ${state.provider.model}`;
  els.devices.textContent = state.iface.devices.join(" / ") || "—";
  els.quantum.textContent = String(state.quantum);

  els.lifecycle.replaceChildren(
    ...state.lifecycle.map((entry) => {
      const item = document.createElement("li");
      item.textContent = entry;
      return item;
    }),
  );
  renderMachine(state);
  renderSources(state);
  renderQuantum(state);
  renderChecks(state);
  renderDecohere(state);
  renderPaths(state);

  els.transcript.replaceChildren(
    ...state.transcript.map((entry) => {
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      bubble.dataset.role = entry.role;
      bubble.textContent = entry.text;
      return bubble;
    }),
  );
  els.transcript.scrollTop = els.transcript.scrollHeight;

  if (state.lastVerdict) {
    els.verdict.textContent = `device.led.set ${state.lastVerdict.ok ? "ok" : state.lastVerdict.reason}`;
    els.verdict.dataset.ok = String(state.lastVerdict.ok);
  }

  els.insert.disabled = busy || state.active;
  els.eject.disabled = busy || !state.active;
}

async function refresh() {
  try {
    render(await call("/api/state"));
  } catch (error) {
    els.verdict.textContent = String(error.message ?? error);
    els.verdict.dataset.ok = "false";
  }
}

async function run(task, label) {
  if (busy) return;
  busy = true;
  els.send.disabled = true;
  try {
    await task();
    await refresh();
  } catch (error) {
    els.verdict.textContent = `${label}: ${String(error.message ?? error)}`;
    els.verdict.dataset.ok = "false";
  } finally {
    busy = false;
    els.send.disabled = false;
    await refresh();
  }
}

els.insert.addEventListener("click", () => run(() => call("/api/core/insert", {}), "插入失败"));
els.eject.addEventListener("click", () => run(() => call("/api/core/eject", {}), "弹出失败"));

els.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = els.text.value.trim();
  if (text.length === 0) return;
  els.text.value = "";
  run(() => call("/api/turn", { text }), "对话失败");
});

els.device.addEventListener("click", () => {
  ledOn = !ledOn;
  run(
    () => call("/api/device", { device: "led", op: "device.led.set", args: { on: ledOn } }),
    "设备请求失败",
  );
});

function connect() {
  const socket = new WebSocket(`ws://${location.host}/ws`);
  socket.addEventListener("open", () => {
    els.link.dataset.online = "true";
    els.link.title = "WebSocket 已连接";
    void refresh();
  });
  socket.addEventListener("message", () => {
    void refresh();
  });
  socket.addEventListener("close", () => {
    els.link.dataset.online = "false";
    els.link.title = "WebSocket 已断开";
    setTimeout(connect, 1500);
  });
}

connect();
void refresh();
