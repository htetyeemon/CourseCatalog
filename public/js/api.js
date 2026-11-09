// Shared API client for Course Catalog static frontend.
// Token is held in memory only (a module-level variable), never in
// localStorage. Call setToken() once per session/page load.
const API = "/v1";

let token = null;

export function setToken(t) {
  token = t || null;
}

export function getToken() {
  return token;
}

export function clearToken() {
  token = null;
}

async function handleResponse(res) {
  let body = null;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    try {
      body = await res.json();
    } catch {
      body = null;
    }
  } else {
    body = await res.text();
  }
  return { ok: res.ok, status: res.status, body, headers: res.headers };
}

export async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...opts.headers };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers,
  });
  return handleResponse(res);
}

// Escape API-provided text to prevent XSS. Use textContent where possible;
// this helper is only for the few places we intentionally insert HTML.
export function htmlEscape(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Render a list of courses into a container as escaped list items.
export function renderCourseListItem(course) {
  const li = document.createElement("li");
  li.className = "course-card";
  const statusBadge = htmlEscape(course.status || "");
  const tags = Array.isArray(course.tags)
    ? course.tags.map(htmlEscape).join(", ")
    : "";
  li.innerHTML = `
    <a href="course.html?id=${htmlEscape(course.id)}" class="course-card__link">
      <h3 class="course-card__title">${htmlEscape(course.code)} — ${htmlEscape(course.title)}</h3>
      <p class="course-card__desc">${htmlEscape(course.description)}</p>
      <div class="course-card__meta">
        <span class="course-card__meta-item">${htmlEscape(course.department)}</span>
        <span class="course-card__meta-item">${htmlEscape(course.level)}</span>
        <span class="course-card__meta-item">${htmlEscape(course.credits)} credits</span>
        <span class="course-card__status status--${statusBadge}">${statusBadge}</span>
      </div>
      ${tags ? `<div class="course-card__tags">${tags}</div>` : ""}
    </a>
  `;
  return li;
}

export function formatDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return String(iso);
  }
}
