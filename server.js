const express = require('express');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const DATA_FILE = 'training.json';
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// זיכרון זמני לאימון
const trainingState = {};

function load() {
  try {
    if (fs.existsSync(DATA_FILE))
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {}
  return { personalInfo: '', examples: [], botEnabled: false };
}

function save(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function buildPrompt(data) {
  let p = `אתה מדמה אדם אמיתי בשיחת וואטסאפ.
ענה קצר וטבעי בדיוק כמו שהאדם הזה היה עונה — בלי הסברים, בלי פתיחה, רק התשובה עצמה.`;

  if (data.personalInfo && data.personalInfo.trim())
    p += `\n\nמידע על האדם:\n${data.personalInfo}`;

  if (data.examples && data.examples.length > 0) {
    p += `\n\nדוגמאות לסגנון הדיבור שלו (חשוב — למד מהן):`;
    data.examples.forEach((ex, i) => {
      p += `\n\n[${i + 1}]\nהודעה נכנסת: "${ex.input}"\nהתשובה שלו: "${ex.output}"`;
    });
  }

  p += `\n\nענה רק את התשובה. קצר. טבעי. כמוהו.`;
  return p;
}

async function sendMsg(chatId, text) {
  await fetch('https://gate.whapi.cloud/messages/text', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.WHAPI_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ to: chatId, body: text }),
  });
}

async function getAiReply(data, message) {
  const r = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 400,
    system: buildPrompt(data),
    messages: [{ role: 'user', content: message }],
  });
  return r.content[0].text;
}

app.get('/api/data', (req, res) => res.json(load()));
app.post('/api/data', (req, res) => { save(req.body); res.json({ ok: true }); });

app.post('/api/test', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'no message' });
  const data = load();
  try {
    const reply = await getAiReply(data, message);
    res.json({ reply });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  const msgs = req.body?.messages;
  if (!msgs) return;

  for (const msg of msgs) {
    if (msg.from_me) continue;
    if (msg.type !== 'text') continue;

    const text = msg.text?.body?.trim();
    const chatId = msg.chat_id;
    if (!text || !chatId) continue;

    const data = load();

    // מצב אימון פעיל — מחכים לתגובת המשתמש
    if (trainingState[chatId]) {
      const { input, reply } = trainingState[chatId];
      delete trainingState[chatId];

      const approved = ['טוב', '✅', '👍', 'ok', 'כן', 'good'].includes(text.toLowerCase());

      if (approved) {
        data.examples.push({ input, output: reply, ts: Date.now() });
        save(data);
        await sendMsg(chatId, `✅ נשמר! (סה"כ ${data.examples.length} דוגמאות)`);
      } else {
        data.examples.push({ input, output: text, ts: Date.now() });
        save(data);
        await sendMsg(chatId, `✅ נשמרה התשובה המתוקנת! (סה"כ ${data.examples.length} דוגמאות)`);
      }
      continue;
    }

    // פקודת אימון
    if (text.startsWith('אימון:')) {
      const testMsg = text.slice(6).trim();
      if (!testMsg) {
        await sendMsg(chatId, 'כתוב הודעה אחרי "אימון:"\nלדוגמה: אימון: מה קורה?');
        continue;
      }

      try {
        const agentReply = await getAiReply(data, testMsg);
        trainingState[chatId] = { input: testMsg, reply: agentReply };
        setTimeout(() => delete trainingState[chatId], 5 * 60 * 1000);

        await sendMsg(chatId,
          `🤖 כך הסוכן היה עונה:\n\n"${agentReply}"\n\n──────────────\n👍 שלח "טוב" לשמור\n✏️ שלח את התשובה הנכונה לתקן`
        );
      } catch (e) {
        await sendMsg(chatId, 'שגיאה: ' + e.message);
      }
      continue;
    }

    // בוט רגיל
    if (!data.botEnabled) continue;

    try {
      const reply = await getAiReply(data, text);
      await sendMsg(chatId, reply);
    } catch (e) {
      console.error('Bot error:', e.message);
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
