let toastWrap = null;

export function showModal({ title, message, icon, actions }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";

    const box = document.createElement("div");
    box.className = "modal-box";

    if (icon) {
      const ic = document.createElement("div");
      ic.className = "modal-icon";
      ic.textContent = icon;
      box.appendChild(ic);
    }

    const h = document.createElement("h3");
    h.className = "modal-title";
    h.textContent = title || "";
    box.appendChild(h);

    if (message) {
      const p = document.createElement("p");
      p.className = "modal-msg";
      p.textContent = message;
      box.appendChild(p);
    }

    const actionsEl = document.createElement("div");
    actionsEl.className = "modal-actions";
    const list = actions && actions.length ? actions : [{ label: "好的", value: true }];
    list.forEach((a) => {
      const btn = document.createElement("button");
      btn.className = `btn ${a.variant || ""}`.trim();
      btn.textContent = a.label;
      btn.addEventListener("click", () => {
        overlay.classList.remove("show");
        setTimeout(() => overlay.remove(), 180);
        resolve(a.value);
      });
      actionsEl.appendChild(btn);
    });
    box.appendChild(actionsEl);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add("show"));
  });
}

export function showToast(text, ms = 2400) {
  if (!toastWrap) {
    toastWrap = document.createElement("div");
    toastWrap.className = "toast-wrap";
    document.body.appendChild(toastWrap);
  }
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = text;
  toastWrap.appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity .25s ease";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 260);
  }, ms);
}

export function confirmDialog(title, message, okLabel = "确定") {
  return showModal({
    title,
    message,
    icon: "🌸",
    actions: [
      { label: "取消", value: false, variant: "ghost" },
      { label: okLabel, value: true },
    ],
  });
}
