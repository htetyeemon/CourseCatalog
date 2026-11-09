import { setToken, getToken } from "./api.js";

// Shared UI helpers: loading/error states, token banner, page shell.

export function showError(containerId, message) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = `
    <div class="empty-state">
      <p class="empty-state__title">Error</p>
      <p class="empty-state__desc">${htmlEscapeShared(message)}</p>
    </div>
  `;
}

export function showEmpty(containerId, message) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = `
    <div class="empty-state">
      <p class="empty-state__title">${htmlEscapeShared(message)}</p>
    </div>
  `;
}

export function showLoading(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = `
    <div class="loader" role="status" aria-label="Loading">
      <span class="sr-only">Loading…</span>
    </div>
  `;
}

export function showContent(containerId, html) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = html;
}

const srStyle = document.createElement("style");
srStyle.textContent = `
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); border: 0; white-space: nowrap; }
`;
document.head?.appendChild(srStyle);

function htmlEscapeShared(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Token banner: shows when no bearer token is in memory.
// Entering a token calls onSet(token) and hides the banner.
export function initTokenBanner({ onSet, containerId = "token-banner" }) {
  let container = document.getElementById(containerId);
  if (!container) {
    container = document.createElement("div");
    container.id = containerId;
    document.body.insertBefore(container, document.body.firstChild);
  }

  container.innerHTML = `
    <div class="token-banner">
      <strong class="token-banner__label">API access required</strong>
      <input type="password" id="token-input" placeholder="Paste bearer JWT (memory only, not stored)" aria-label="Bearer JWT" />
      <button type="button" id="token-submit">Enter</button>
      <span class="token-banner__hint">Held in memory for this tab only. Refresh clears it.</span>
    </div>
  `;

  const input = container.querySelector("#token-input");
  const submit = container.querySelector("#token-submit");

  const apply = () => {
    const value = input.value.trim();
    if (!value) return;
    setToken(value);
    container.style.display = "none";
    if (onSet) onSet(value);
  };

  submit.addEventListener("click", apply);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") apply();
  });

  // Show banner only if no token yet.
  if (!getToken()) {
    container.style.display = "block";
  } else {
    container.style.display = "none";
  }

  return { setToken };
}

// Minimal toast for transient messages.
export function toast(message, duration = 3000) {
  let el = document.getElementById("app-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "app-toast";
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.style.display = "block";
  clearTimeout(el.dataset.timer);
  el.dataset.timer = setTimeout(() => {
    el.style.display = "none";
  }, duration);
}

// Pagination controls.
export function renderPagination({ page, total, limit, onPage }) {
  const pages = Math.max(1, Math.ceil(total / limit));
  const wrap = document.createElement("div");
  wrap.className = "pagination";
  wrap.setAttribute("aria-label", "Pagination");

  const btn = (label, p, disabled, current) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.disabled = disabled || p < 1 || p > pages;
    if (current) b.className = "pagination__btn--current";
    if (!b.disabled && onPage) b.addEventListener("click", () => onPage(p));
    return b;
  };

  wrap.appendChild(btn("← Prev", page - 1, page <= 1));
  for (let p = 1; p <= pages; p += 1) {
    wrap.appendChild(btn(String(p), p, false, p === page));
  }
  wrap.appendChild(btn("Next →", page + 1, page >= pages));

  return wrap;
}
