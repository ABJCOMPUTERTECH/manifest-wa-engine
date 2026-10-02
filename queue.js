function getRandomDelay() {
  return Math.floor(Math.random() * (12000 - 5000 + 1)) + 5000;
}

function parseSpintax(text) {
  const matches = text.match(/\{[^{}]*\}/g);
  if (!matches) return text;
  for (let match of matches) {
    const options = match.slice(1, -1).split('|');
    const choice = options[Math.floor(Math.random() * options.length)];
    text = text.replace(match, choice);
  }
  return parseSpintax(text);
}

module.exports = { getRandomDelay, parseSpintax };
