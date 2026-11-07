import "dotenv/config";
import { app } from "./app.js";

// Local / long-running server. The routes live in app.ts so the Vercel
// function (vercel.ts) serves the same app without listen().
const port = process.env.PORT ? Number(process.env.PORT) : 4000;
app.listen(port, () => {
  console.log(`BrokerForce API listening on :${port}`);
});
