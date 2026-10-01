const http = require('node:http');
const { URL } = require('node:url');

const PORT = process.env.PORT || 3000;
const BFL_KEY = process.env.BFL_API_KEY;
const BFL_ENDPOINT = 'https://api.bfl.ai/v1/flux-tools/vto-v2';

const MAX_BODY = 15 * 1024 * 1024;
const MAX_MP = 4;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, { ...CORS, 'Content-Type': 'application/json' });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Imagem muito grande (máx 15MB).'), { code: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('JSON inválido.'), { code: 400 })); }
    });
    req.on('error', reject);
  });
}

function megapixels(dataUrl) {
  const m = /^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/i.exec(dataUrl || '');
  if (!m) return null;
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length < 24) return null;
  let w, h;
  if (m[1].toLowerCase() === 'png') {
    w = bytes.readUInt32BE(16);
    h = bytes.readUInt32BE(20);
  } else {
    let i = 2;
    while (i < bytes.length) {
      if (bytes[i] !== 0xff) break;
      const marker = bytes[i + 1];
      const len = bytes.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        h = bytes.readUInt16BE(i + 5);
        w = bytes.readUInt16BE(i + 7);
        break;
      }
      i += 2 + len;
    }
  }
  if (!w || !h) return null;
  return (w * h) / 1e6;
}

function buildPrompt(productName, garmentDesc) {
  const garment = garmentDesc?.trim()
    ? garmentDesc.trim()
    : `the ${productName} outfit`;
  return `The person of image 1, maintaining exactly their face, identity, expression, `
    + `body proportions, skin tone, hair and full-body pose, wearing ${garment}. `
    + `Preserve the shoes, personal accessories, background, lighting and camera angle `
    + `from image 1. Photorealistic, natural draping and fabric folds, `
    + `no added text, no watermark, no extra people.`;
}

async function pollBFL(pollingUrl, deadline) {
  for (;;) {
    if (Date.now() > deadline) {
      throw Object.assign(new Error('Tempo esgotado aguardando a imagem (60s).'), { code: 504 });
    }
    const res = await fetch(pollingUrl, { headers: { 'x-key': BFL_KEY } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw Object.assign(
        new Error(data.detail || data.error?.message || `BFL respondeu ${res.status}.`),
        { code: 502 }
      );
    }
    if (data.status === 'Ready') return data.result.sample;
    if (data.status === 'Error') {
      throw Object.assign(new Error(data.error?.message || 'A geração falhou na BFL.'), { code: 502 });
    }
    await new Promise(r => setTimeout(r, 900));
  }
}

async function handleTryOn(req, res) {
  if (!BFL_KEY) {
    return json(res, 503, {
      error: 'BFL_API_KEY nao configurada. Crie um arquivo .env na raiz com BFL_API_KEY=r8_... e reinicie o servidor.'
    });
  }

  const body = await readBody(req);
  const { image, prompt, garment, productName, seed } = body || {};

  if (!image || !String(image).startsWith('data:image/')) {
    return json(res, 400, { error: 'Envie a sua foto em base64 (data URL).' });
  }

  const mp = megapixels(image);
  if (mp && mp > MAX_MP) {
    return json(res, 400, {
      error: `Sua foto tem ${mp.toFixed(1)}MP. O limite e ${MAX_MP}MP. Reduza a resolucao antes de enviar.`
    });
  }

  const payload = {
    prompt: buildPrompt(productName || 'the selected look', garment),
    person: image,
    output_format: 'png'
  };
  if (garment && String(garment).startsWith('data:image/')) payload.garment = garment;
  if (Number.isInteger(seed)) payload.seed = seed;

  let meta;
  try {
    const submit = await fetch(BFL_ENDPOINT, {
      method: 'POST',
      headers: { 'x-key': BFL_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    meta = await submit.json().catch(() => ({}));
    if (!submit.ok) {
      const msg = meta.detail || meta.error?.message || `BFL respondeu ${submit.status}.`;
      const hint = /billing|credit|payment|quota/i.test(msg)
        ? ' Verifique o saldo em dashboard.bfl.ai.'
        : '';
      return json(res, 502, { error: msg + hint });
    }
  } catch (e) {
    return json(res, 502, { error: `Falha de rede ao contatar a BFL: ${e.message}` });
  }

  if (!meta.polling_url) {
    return json(res, 502, { error: 'A BFL nao devolveu polling_url.' });
  }

  try {
    const sample = await pollBFL(meta.polling_url, Date.now() + 60000);
    return json(res, 200, { image: sample });
  } catch (e) {
    return json(res, e.code || 502, { error: e.message });
  }
}

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }

  if (req.method === 'GET' && pathname === '/api/health') {
    return json(res, 200, {
      ok: true,
      configured: Boolean(BFL_KEY),
      model: 'flux-vtools-vto-v2'
    });
  }

  if (req.method === 'POST' && pathname === '/api/tryon') {
    return handleTryOn(req, res).catch(e =>
      json(res, e.code || 500, { error: e.message || 'Erro interno.' })
    );
  }

  json(res, 404, { error: 'Rota nao encontrada.' });
});

server.listen(PORT, () => {
  console.log(`STYLEFIT api  ->  http://localhost:${PORT}`);
  console.log(BFL_KEY ? 'BFL_API_KEY carregada.' : 'AVISO: BFL_API_KEY ausente (veja .env.example)');
});