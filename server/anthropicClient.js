const Anthropic = require('@anthropic-ai/sdk');

let anthropic = null;

function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('Missing ANTHROPIC_API_KEY environment variable');
  }
  if (!anthropic) {
    anthropic = new Anthropic();
  }
  return anthropic;
}

module.exports = {
  get messages() {
    return getClient().messages;
  },
};
