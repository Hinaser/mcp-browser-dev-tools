import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";

const PAGES = {
  "/signup": "signup.html",
  "/payment": "payment.html",
  "/login": "login.html",
  "/app/settings": "settings.html",
};

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function code(prefix) {
  return `${prefix}-${randomBytes(3).toString("hex").toUpperCase()}`;
}

function newRunState() {
  return {
    signup: null,
    signupAttempts: 0,
    pay: { attempts: 0, inFlight: 0, overlaps: 0, receipt: null },
    signedIn: false,
    loginAttempts: 0,
    settings: { email: true, digest: false, language: "en" },
    revision: 0,
  };
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) : {};
}

function send(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

// Serves the fixture pages and their APIs on loopback, keeping state per run
// id so the runner can judge what the agent actually did.
export async function startFixtureServer({ fixturesDir }) {
  const runs = new Map();
  const stateFor = (run) => {
    if (!runs.has(run)) {
      runs.set(run, newRunState());
    }
    return runs.get(run);
  };

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const run = url.searchParams.get("run") ?? "";
    try {
      const page = PAGES[url.pathname];
      if (request.method === "GET" && page) {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(await readFile(new URL(page, fixturesDir)));
        return;
      }

      const state = stateFor(run);
      switch (`${request.method} ${url.pathname}`) {
        case "POST /api/signup": {
          const body = await readJson(request);
          state.signupAttempts += 1;
          await sleep(800);
          if (!body.name || !body.email?.includes("@") || !body.plan) {
            send(response, 400, {
              error: "Please fill in your name, email, and plan.",
            });
            return;
          }
          if (body.terms !== true) {
            send(response, 400, { error: "Please accept the terms." });
            return;
          }
          state.signup = { ...body, code: code("CONF") };
          send(response, 200, state.signup);
          return;
        }
        case "POST /api/pay": {
          // Decide by this request's own attempt number, so overlapping
          // requests cannot make an early attempt succeed.
          state.pay.attempts += 1;
          const attempt = state.pay.attempts;
          if (state.pay.inFlight > 0) {
            state.pay.overlaps += 1;
          }
          state.pay.inFlight += 1;
          await sleep(1200);
          state.pay.inFlight -= 1;
          if (state.pay.receipt) {
            send(response, 200, { ok: true, receipt: state.pay.receipt });
          } else if (attempt < 3) {
            send(response, 200, { ok: false, error: "card declined" });
          } else {
            state.pay.receipt = code("RCPT");
            send(response, 200, { ok: true, receipt: state.pay.receipt });
          }
          return;
        }
        case "POST /api/login": {
          const body = await readJson(request);
          state.loginAttempts += 1;
          await sleep(500);
          if (body.username === "demo" && body.password === "hunter2") {
            state.signedIn = true;
            send(response, 200, { ok: true });
          } else {
            send(response, 401, { ok: false });
          }
          return;
        }
        case "GET /api/session":
          send(response, 200, {
            signedIn: state.signedIn,
            settings: state.settings,
            revision: state.revision,
          });
          return;
        case "POST /api/settings": {
          const body = await readJson(request);
          await sleep(600);
          if (!state.signedIn) {
            send(response, 401, { error: "Not signed in" });
            return;
          }
          state.settings = {
            email: body.email === true,
            digest: body.digest === true,
            language: body.language,
          };
          state.revision += 1;
          send(response, 200, { revision: state.revision });
          return;
        }
        default:
          response.writeHead(404);
          response.end();
      }
    } catch (error) {
      send(response, 500, { error: error.message });
    }
  });

  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    state: (run) => stateFor(run),
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
      }),
  };
}
