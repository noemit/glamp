import app from '../index.mjs';
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3000);
app.listen(port, host, () => console.log(`Glamp is listening on http://${host}:${port}`));
