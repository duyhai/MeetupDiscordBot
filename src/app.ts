import express from 'express';
import { Logger } from 'tslog';

const app = express();
const port = 3000;
const logger = new Logger({ name: 'App' });

app.get('/', (req, res) => {
  res.send('Hello World!');
});

app.listen(port, () => logger.info(`Express is listening at http://localhost:${port}`));
