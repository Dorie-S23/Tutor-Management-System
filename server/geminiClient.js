const { GoogleGenAI } = require("@google/genai");

let gemini = null;

function getClient() {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("Missing GEMINI_API_KEY environment variable");
  }
  if (!gemini) {
    gemini = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return gemini;
}

module.exports = {
  get models() {
    return getClient().models;
  },
};
