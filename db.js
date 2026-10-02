const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'db.json');

function readData() {
  if (!fs.existsSync(DB_FILE)) {
    const initial = { users: [], sessions: [] };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
  } catch (e) {
    return { users: [], sessions: [] };
  }
}

function writeData(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

module.exports = {
  get(collection) {
    const data = readData();
    const list = data[collection] || [];
    return {
      value: () => list,
      find: (predicate) => {
        const item = list.find(x => Object.keys(predicate).every(k => x[k] === predicate[k]));
        return {
          value: () => item,
          assign: (updates) => {
            if (item) Object.assign(item, updates);
            return { write: () => writeData(data) };
          }
        };
      },
      remove: (predicate) => {
        const filtered = list.filter(x => !Object.keys(predicate).every(k => x[k] === predicate[k]));
        data[collection] = filtered;
        return { write: () => writeData(data) };
      },
      push: (newItem) => {
        list.push(newItem);
        data[collection] = list;
        return { write: () => writeData(data) };
      }
    };
  }
};
