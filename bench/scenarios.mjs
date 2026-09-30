// Benchmark scenarios. Each one opens a fixture page served by
// fixture-server.mjs, gives the agent one task prompt, and judges success
// from what the fixture server recorded plus the agent's final reply, so a
// run only passes when the page flow really completed.

export const SCENARIOS = [
  {
    id: "signup",
    title: "Sign up behind a late cookie banner",
    path: "/signup",
    summary:
      "A consent banner covers the form 500 ms after load. The agent has to dismiss it, fill a name, an email, and a plan select, tick the terms checkbox, submit, wait for the account to be created (800 ms), and read the confirmation code.",
    task: 'Sign up with the full name "Ada Lovelace", the email "ada@example.com", and the Pro plan, accepting the terms. Deal with anything that gets in the way. Reply with only the confirmation code shown after signing up.',
    check({ state, reply }) {
      const signup = state.signup;
      if (!signup) {
        return { ok: false, detail: "no signup was submitted" };
      }
      if (
        signup.name !== "Ada Lovelace" ||
        signup.email !== "ada@example.com" ||
        signup.plan !== "pro" ||
        signup.terms !== true
      ) {
        return {
          ok: false,
          detail: `wrong signup ${JSON.stringify(signup)}`,
        };
      }
      if (!reply.includes(signup.code)) {
        return { ok: false, detail: "reply lacks the confirmation code" };
      }
      return { ok: true, detail: `signups=${state.signupAttempts}` };
    },
  },
  {
    id: "payment-retry",
    title: "Retry a failing payment until it succeeds",
    path: "/payment",
    summary:
      "Each payment attempt takes 1.2 s and the first two are declined. The agent has to pay, notice the failure, retry without paying twice at once, and read the receipt number from the third attempt.",
    task: "Pay for the order. The payment may fail temporarily; retry until it succeeds, but never start a new attempt while one is still processing. Reply with only the receipt number.",
    check({ state, reply }) {
      const pay = state.pay;
      if (!pay.receipt) {
        return { ok: false, detail: `not paid after ${pay.attempts} attempts` };
      }
      if (pay.overlaps > 0) {
        return { ok: false, detail: `${pay.overlaps} overlapping attempts` };
      }
      if (!reply.includes(pay.receipt)) {
        return { ok: false, detail: "reply lacks the receipt number" };
      }
      return { ok: true, detail: `attempts=${pay.attempts}` };
    },
  },
  {
    id: "settings-login",
    title: "Change settings behind a login redirect",
    path: "/app/settings",
    summary:
      "The settings page redirects to a login form. The agent has to sign in, come back to settings, change two checkboxes and a language select, save (600 ms), and report the revision shown after saving; the save toast disappears after 2.5 s.",
    task: 'Sign in with the username "demo" and the password "hunter2" if asked. Then turn off email notifications, turn on the weekly digest, set the language to Japanese, and save. Reply with only the settings revision number shown after saving.',
    check({ state, reply }) {
      const { settings, revision } = state;
      if (revision === 0) {
        return { ok: false, detail: "settings were never saved" };
      }
      if (
        settings.email !== false ||
        settings.digest !== true ||
        settings.language !== "ja"
      ) {
        return {
          ok: false,
          detail: `wrong settings ${JSON.stringify(settings)}`,
        };
      }
      if (!new RegExp(`\\b${revision}\\b`).test(reply)) {
        return { ok: false, detail: `reply lacks revision ${revision}` };
      }
      return { ok: true, detail: `saves=${revision}` };
    },
  },
];

export function scenarioPrompt(scenario, { url, targetId, hint }) {
  return [
    `A Chrome tab is already open at ${url} (target id ${targetId}).`,
    "Use the browser tools to attach to that tab and complete the task there. Do not open other tabs.",
    ...(hint ? [hint] : []),
    "",
    `Task: ${scenario.task}`,
  ].join("\n");
}
