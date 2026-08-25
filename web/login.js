const form = document.getElementById("login-form");
const input = document.getElementById("password");
const submit = document.getElementById("submit");
const error = document.getElementById("error");

/** Only same-origin paths, so a crafted `?next=` cannot bounce us off-site. */
function nextPath() {
  const raw = new URLSearchParams(location.search).get("next");
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  return raw;
}

function fail(message) {
  error.textContent = message;
  input.select();
  input.focus();
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  error.textContent = "";
  submit.disabled = true;
  submit.textContent = "Signing in…";

  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: input.value }),
    });

    if (response.ok) {
      location.replace(nextPath());
      return;
    }

    const body = await response.json().catch(() => ({}));
    if (response.status === 429) {
      fail(`Too many attempts. Try again in ${body.retryAfter ?? 60}s.`);
    } else {
      fail("Wrong password.");
    }
  } catch {
    fail("Could not reach the server.");
  } finally {
    submit.disabled = false;
    submit.textContent = "Sign in";
  }
});
