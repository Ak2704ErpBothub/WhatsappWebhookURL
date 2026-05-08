require('dotenv').config();
const express = require('express');
const logger = require('./logger');

const app = express();
app.use(express.json());

const port = process.env.PORT || 3000;
const verifyToken = process.env.VERIFY_TOKEN;

app.get('/', (req, res) => {
  const { 'hub.mode': mode, 'hub.challenge': challenge, 'hub.verify_token': token } = req.query;

  if (mode === 'subscribe' && token === verifyToken) {
    logger.info('Webhook verified');
    res.status(200).send(challenge);
  } else {
    logger.warn('Webhook verification failed', { mode, token });
    res.status(403).end();
  }
});

app.post('/', (req, res) => {
  logger.info('Webhook received', { body: req.body });
  res.status(200).end();
});

app.listen(port, () => {
  logger.info(`Server listening on port ${port}`);
});
