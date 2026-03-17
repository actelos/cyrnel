import { createApp } from "@/app";

const app = createApp();
const PORT = Number(process.env.PORT ?? 7687);

app.listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT}`);
});
