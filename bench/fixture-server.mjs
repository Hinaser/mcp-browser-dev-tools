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

const RESEARCH_TOPICS = ["Harbor", "Lattice", "Meridian", "Quarry", "Tundra"];
const RESEARCH_ARTICLE_DELAY_MS = 1500;

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"]/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char],
  );
}

function researchResultsPage(run) {
  const results = RESEARCH_TOPICS.map(
    (topic, index) => `<article class="result">
  <h2><a href="/research/article/${index + 1}?run=${encodeURIComponent(run)}">${topic} component overview</a></h2>
  <p>Design notes, release history, and the current codename of the ${topic} component.</p>
</article>`,
  ).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Search: component codenames</title></head>
<body><header><a href="/">Docs home</a> <a href="/about">About</a></header>
<h1>Results for "component codenames"</h1>
${results}
<footer>5 results</footer></body></html>`;
}

function researchArticlePage(index, codename) {
  const topic = RESEARCH_TOPICS[index];
  const filler = Array.from(
    { length: 6 },
    (_, n) =>
      `<p>Section ${n + 1}: the ${topic} component handles part ${n + 1} of the pipeline. It was reviewed in the quarterly design meeting and has no open issues.</p>`,
  ).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${topic} component overview</title></head>
<body><nav><a href="/">Docs home</a> <a href="/research">Back to results</a></nav>
<main><h1>${topic} component overview</h1>
${filler}
<p>Release history: the ${topic} component shipped in three releases. Its current release codename is <strong>${escapeHtml(codename)}</strong>.</p>
</main><footer>Last updated this quarter</footer></body></html>`;
}

function newRunState() {
  return {
    research: {
      codenames: RESEARCH_TOPICS.map(() => code("CN")),
      opened: [],
    },
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
      if (request.method === "GET" && url.pathname === "/research") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(researchResultsPage(run));
        return;
      }
      const article = url.pathname.match(/^\/research\/article\/([1-5])$/);
      if (request.method === "GET" && article) {
        // Each article is slow, like a real site, so reading them one after
        // another costs noticeably more than reading them at once.
        const index = Number(article[1]) - 1;
        const research = stateFor(run).research;
        if (!research.opened.includes(index + 1)) {
          research.opened.push(index + 1);
        }
        await sleep(RESEARCH_ARTICLE_DELAY_MS);
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(researchArticlePage(index, research.codenames[index]));
        return;
      }

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
