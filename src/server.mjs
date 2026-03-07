import { createBrowserDevToolsApp } from "./app.mjs";

const app = createBrowserDevToolsApp();
app.installSignalHandlers();
app.start();
