/* Feedback Fin adaptation for afeiii. Based on buildship-ai/feedbackfin (Apache-2.0).
 * Changes: native accessible dialog, Chinese UI, strict payload allowlist, real HTTP
 * acknowledgement, timeout/idempotence, optional anonymous operation counts.
 * Upstream: https://github.com/buildship-ai/feedbackfin ; see LICENSE.txt. */
(() => {
  "use strict";
  if (window.feedbackfin || !document.body) return;
  const sites = { "afeiii.com": "portal", "tools.afeiii.com": "tools", "pdf.afeiii.com": "pdf", "convert.afeiii.com": "convert", "resume.afeiii.com": "resume", "check.afeiii.com": "check" };
  const site = sites[location.hostname];
  if (!site || location.pathname.startsWith("/search-admin")) return;
  const endpoint = "https://afeiii.com/engagement/v1/";
  const phases = new Set(["entry", "start", "success", "failure", "download"]);
  const privacy = () => navigator.doNotTrack === "1" || navigator.globalPrivacyControl === true;
  let enabled = false;
  try { enabled = localStorage.getItem("afeiii-anonymous-usage") === "yes"; } catch { /* storage optional */ }
  let catalog;
  let dialog;
  let tool = "home";
  const sent = new Set();
  function toolAtPath() {
    // Only return public registry identifiers. Never send raw paths, queries or fragments.
    const path = location.pathname.replace(/\/$/, "").replace(/\.html$/, "");
    if (site === "resume") return path === "" ? "home" : "export";
    if (site === "convert") return path.startsWith("/convert") ? "convert" : "home";
    if (site === "check" && path.startsWith("/check/")) return "scan";
    if (site === "pdf") {
      const slug = path.split("/").at(-1);
      return Object.hasOwn(catalog[site], slug) ? slug : "home";
    }
    const slug = path.slice(1);
    return Object.hasOwn(catalog[site], slug) ? slug : "home";
  }
  async function post(channel, payload) {
    const response = await fetch(endpoint + channel, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(12000),
    });
    const result = await response.json();
    if (!response.ok || result.received !== true) throw Error(result.error || "暂时无法接收，请稍后重试。");
    return result;
  }
  function usage(detail) {
    if (!catalog || !enabled || privacy() || !detail || !phases.has(detail.phase)) return;
    const id = detail.id;
    const name = detail.tool || toolAtPath();
    if (typeof id !== "string" || typeof name !== "string" || !/^[a-f0-9-]{36}$/.test(id) || !Object.hasOwn(catalog[site], name)) return;
    const key = id + ":" + detail.phase;
    if (sent.has(key) || sent.size >= 500) return;
    sent.add(key);
    // Construct a new object: ignore any extra content passed by callers.
    void post("events", { id, site, tool: name, phase: detail.phase }).catch(() => {});
  }
  function entry() {
    if (!catalog) return;
    tool = toolAtPath();
    // Private URLs must not cause automatic navigation telemetry.
    if ((site === "resume" && tool !== "home") || (site === "check" && tool === "scan") || (site === "convert" && tool === "convert")) return;
    usage({ id: crypto.randomUUID(), phase: "entry", tool });
  }
  function node(tag, text, props = {}) {
    const el = document.createElement(tag);
    if (text) el.textContent = text;
    Object.assign(el, props);
    return el;
  }
  function buildDialog() {
    dialog = node("dialog", "", { id: "feedbackfin-dialog", className: "feedbackfin-dialog" });
    dialog.setAttribute("aria-labelledby", "feedbackfin-title");
    const heading = node("div", "", { className: "feedbackfin-heading" });
    heading.append(node("h2", "反馈问题", { id: "feedbackfin-title" }));
    const close = node("button", "×", { type: "button", className: "feedbackfin-close" });
    close.setAttribute("aria-label", "关闭反馈");
    close.addEventListener("click", () => dialog.close());
    heading.append(close);
    const hint = node("p", "只发送你在此表单填写的内容及工具名称。请勿填写密码、令牌、简历或文件原文。", { className: "feedbackfin-note" });
    const form = node("form");
    form.noValidate = true;
    const label = (text, input) => {
      const item = node("label", text, { className: "feedbackfin-field" });
      item.append(input); form.append(item); return input;
    };
    const kind = node("select", "", { name: "kind" });
    for (const [value, title] of [["issue", "功能问题"], ["idea", "改进建议"], ["other", "其他反馈"]]) kind.append(node("option", title, { value }));
    label("反馈类型", kind);
    const message = label("问题描述（必填）", node("textarea", "", { name: "message", required: true, minLength: 5, maxLength: 2000, rows: 5, placeholder: "操作到哪一步遇到了什么问题？请填写 5–2000 字。" }));
    const contact = label("联系邮箱（可选，用于回复）", node("input", "", { name: "contact", type: "email", maxLength: 120, autoComplete: "email" }));
    const honey = label("请留空", node("input", "", { name: "website", type: "text", tabIndex: -1, autoComplete: "off" }));
    honey.parentElement.hidden = true;
    const status = node("p", "", { className: "feedbackfin-status" });
    status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
    const submit = node("button", "发送反馈", { type: "submit", className: "feedbackfin-submit" });
    const controls = node("div", "", { className: "feedbackfin-actions" });
    controls.append(submit, node("a", "也可发送邮件", { href: "mailto:support@afeiii.com" }));
    form.append(status, controls);
    const preference = node("label", "", { className: "feedbackfin-preference" });
    const checkbox = node("input", "", { type: "checkbox", checked: enabled && !privacy(), disabled: privacy() });
    preference.append(checkbox, node("span", "允许匿名操作统计（开始、成功、失败、下载；不含输入内容）"));
    checkbox.addEventListener("change", () => {
      enabled = checkbox.checked;
      try { localStorage.setItem("afeiii-anonymous-usage", enabled ? "yes" : "no"); } catch { /* session only */ }
      if (enabled) entry();
    });
    let requestId;
    let previous;
    let busy = false;
    form.addEventListener("input", () => { status.textContent = ""; });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (busy || !form.reportValidity()) return;
      if (message.value.trim().length < 5) { status.textContent = "请填写至少 5 字的问题描述。"; message.focus(); return; }
      const fields = { site, tool: toolAtPath(), kind: kind.value, message: message.value.trim(), contact: contact.value.trim(), website: honey.value };
      const snapshot = JSON.stringify(fields);
      if (previous !== snapshot) { requestId = crypto.randomUUID(); previous = snapshot; }
      busy = true; submit.disabled = true; submit.textContent = "发送中…"; status.textContent = "";
      try {
        const result = await post("feedback", { ...fields, id: requestId });
        if (result.id !== requestId) throw Error("接收确认不匹配，请重试。");
        status.textContent = "已收到反馈，感谢帮助我们改进。";
        form.reset(); previous = undefined; requestId = undefined;
      } catch (error) {
        status.textContent = error.name === "TimeoutError" ? "接收确认超时，内容已保留；可安全重试。" : "发送未确认，内容已保留。请稍后重试或发送邮件。";
      } finally {
        busy = false; submit.disabled = false; submit.textContent = "发送反馈";
      }
    });
    dialog.append(heading, hint, form, preference, node("a", "隐私说明", { href: "https://afeiii.com/privacy/", target: "_blank", rel: "noopener noreferrer" }));
    document.body.append(dialog);
  }
  window.feedbackfin = { open() { if (!dialog) buildDialog(); if (!dialog.open) dialog.showModal(); }, close() { dialog?.close(); } };
  document.addEventListener("afeiii:usage", (event) => usage(event.detail));
  document.addEventListener("click", (event) => {
    const button = event.target instanceof Element && event.target.closest("[data-feedbackfin-button]");
    if (button) { event.preventDefault(); window.feedbackfin.open(); }
  });
  fetch("/engagement/catalog.json", { credentials: "omit", referrerPolicy: "no-referrer" }).then((r) => {
    if (!r.ok) throw Error(); return r.json();
  }).then((value) => {
    catalog = value;
    if (!catalog[site]) return;
    const button = node("button", "反馈问题", { type: "button", className: "feedbackfin-trigger" });
    button.dataset.feedbackfinButton = "";
    button.setAttribute("aria-haspopup", "dialog");
    document.body.append(button);
    entry();
  }).catch(() => { /* Core tool functions remain available when feedback assets fail. */ });
})();
