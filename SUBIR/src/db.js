const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { isLinkBloqueado } = require('./bloqueados');
const { classificarCamada1Texto } = require('./classificador');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const criativosDir = path.join(dataDir, 'criativos');
if (!fs.existsSync(criativosDir)) {
  fs.mkdirSync(criativosDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'mineradora.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS anuncios (
    ad_archive_id TEXT PRIMARY KEY,
    page_id TEXT,
    page_name TEXT,
    start_date INTEGER,
    dias_rodando INTEGER,
    collation_count INTEGER,
    link_url TEXT,
    tipo TEXT,
    whatsapp TEXT,
    texto TEXT,
    palavra_chave TEXT,
    data_coleta TEXT,
    tipo_oferta TEXT,
    preco_min REAL,
    preco_max REAL,
    checkout TEXT,
    motivo_filtro TEXT,
    video_url TEXT,
    thumb_url TEXT,
    imagem_url TEXT
  )
`);

// Garantir colunas novas caso a tabela já exista de versão anterior
const colunasExistentes = db
  .prepare('PRAGMA table_info(anuncios)')
  .all()
  .map((c) => c.name);

const novasColunas = [
  { nome: 'tipo', sql: 'ALTER TABLE anuncios ADD COLUMN tipo TEXT' },
  { nome: 'whatsapp', sql: 'ALTER TABLE anuncios ADD COLUMN whatsapp TEXT' },
  { nome: 'tipo_oferta', sql: 'ALTER TABLE anuncios ADD COLUMN tipo_oferta TEXT' },
  { nome: 'preco_min', sql: 'ALTER TABLE anuncios ADD COLUMN preco_min REAL' },
  { nome: 'preco_max', sql: 'ALTER TABLE anuncios ADD COLUMN preco_max REAL' },
  { nome: 'checkout', sql: 'ALTER TABLE anuncios ADD COLUMN checkout TEXT' },
  { nome: 'motivo_filtro', sql: 'ALTER TABLE anuncios ADD COLUMN motivo_filtro TEXT' },
  { nome: 'video_url', sql: 'ALTER TABLE anuncios ADD COLUMN video_url TEXT' },
  { nome: 'thumb_url', sql: 'ALTER TABLE anuncios ADD COLUMN thumb_url TEXT' },
  { nome: 'imagem_url', sql: 'ALTER TABLE anuncios ADD COLUMN imagem_url TEXT' },
];

for (const col of novasColunas) {
  if (!colunasExistentes.includes(col.nome)) {
    db.exec(col.sql);
  }
}

function extrairUrlRealSeRedirectFacebook(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    if (host === 'l.facebook.com' || host === 'lm.facebook.com' || host === 'l.instagram.com') {
      const destino = parsed.searchParams.get('u');
      if (destino && destino.trim()) {
        return destino.trim();
      }
      return null;
    }
    return rawUrl;
  } catch (_) {
    return rawUrl;
  }
}

function extrairNumeroWhatsApp(rawUrl, textoOpcional = '') {
  if (rawUrl && typeof rawUrl === 'string') {
    try {
      const parsed = new URL(rawUrl);
      const phoneParam = parsed.searchParams.get('phone');
      if (phoneParam) {
        const digits = phoneParam.replace(/\D/g, '');
        if (digits.length >= 8) return digits;
      }

      const host = parsed.hostname.toLowerCase();
      if (host === 'wa.me' || host.endsWith('.wa.me')) {
        const pathPart = parsed.pathname.replace(/^\/+/, '').split('/')[0];
        const digits = pathPart.replace(/\D/g, '');
        if (digits.length >= 8) return digits;
      }

      const matchUrl = rawUrl.match(/(?:wa\.me\/|phone=)\+?(\d{8,15})/i);
      if (matchUrl && matchUrl[1]) {
        return matchUrl[1];
      }
    } catch (_) {
      const matchUrl = rawUrl.match(/(?:wa\.me\/|phone=)\+?(\d{8,15})/i);
      if (matchUrl && matchUrl[1]) {
        return matchUrl[1];
      }
    }
  }

  if (textoOpcional && typeof textoOpcional === 'string') {
    const matchTexto = textoOpcional.match(/(?:wa\.me\/|phone=)\+?(\d{10,15})/i);
    if (matchTexto && matchTexto[1]) {
      return matchTexto[1];
    }
  }

  return null;
}

function limparUrlPagina(url) {
  if (!url || typeof url !== 'string') return null;
  const idx = url.indexOf('?');
  return idx !== -1 ? url.substring(0, idx) : url;
}

/**
 * Classifica o anúncio como "pagina", "whatsapp" ou "descartar":
 * 1. Considera como "whatsapp" (NÃO descartar) quando:
 *    - ctaType === "WHATSAPP_MESSAGE" ou ctaText tiver "WhatsApp" (mesmo sem link_url)
 *    - ou link_url tiver wa.me / api.whatsapp.com / whatsapp.com.
 *    Se houver número, salva. Se não houver, salva mesmo assim com número vazio ("").
 * 2. Só descarta quando não tiver link E não for WhatsApp (ou se o link for interno Meta/marketplace bloqueado e não for WhatsApp).
 */
function classificarLink(rawLinkUrl, textoOpcional = '', ctaType = '', ctaText = '') {
  const ctaTypeUpper = String(ctaType || '').toUpperCase();
  const ctaTextLower = String(ctaText || '').toLowerCase();
  const isCtaWhatsApp =
    ctaTypeUpper === 'WHATSAPP_MESSAGE' || ctaTextLower.includes('whatsapp');

  let url = rawLinkUrl && typeof rawLinkUrl === 'string' ? rawLinkUrl.trim() : '';
  if (url) {
    const desencapsulada = extrairUrlRealSeRedirectFacebook(url);
    url = desencapsulada || '';
  }

  let host = '';
  if (url) {
    try {
      const parsed = new URL(url);
      host = parsed.hostname.toLowerCase();
    } catch (_) {
      host = '';
    }
  }

  const isUrlWhatsApp =
    host === 'wa.me' ||
    host.endsWith('.wa.me') ||
    host === 'api.whatsapp.com' ||
    host === 'whatsapp.com' ||
    host.endsWith('.whatsapp.com') ||
    url.toLowerCase().includes('wa.me') ||
    url.toLowerCase().includes('api.whatsapp.com');

  if (isCtaWhatsApp || isUrlWhatsApp) {
    const numero = extrairNumeroWhatsApp(url, textoOpcional) || '';
    const linkFinal = numero ? `https://wa.me/${numero}` : url || null;
    return {
      tipo: 'whatsapp',
      linkLimpo: linkFinal,
      whatsapp: numero,
    };
  }

  // Se não é WhatsApp e não tem link válido -> descartar
  if (!url || !host) {
    return { tipo: 'descartar', linkLimpo: null, whatsapp: null, motivo: 'sem_link' };
  }

  const dominiosMetaDescartar = [
    'facebook.com',
    'fb.com',
    'fb.me',
    'm.me',
    'instagram.com',
  ];

  const isMetaInterno = dominiosMetaDescartar.some(
    (d) => host === d || host.endsWith('.' + d)
  );
  if (isMetaInterno) {
    return { tipo: 'descartar', linkLimpo: null, whatsapp: null, motivo: 'dominio_meta' };
  }

  if (isLinkBloqueado(url)) {
    return { tipo: 'descartar', linkLimpo: null, whatsapp: null, motivo: 'marketplace_bloqueado' };
  }

  return {
    tipo: 'pagina',
    linkLimpo: limparUrlPagina(url),
    whatsapp: null,
  };
}

function reclassificarBancoExistente() {
  const todos = db.prepare('SELECT * FROM anuncios').all();
  let mantidosPagina = 0;
  let mantidosWhatsapp = 0;
  let removidos = 0;

  const updateStmt = db.prepare(`
    UPDATE anuncios
    SET link_url = @link_url,
        tipo = @tipo,
        whatsapp = @whatsapp
    WHERE ad_archive_id = @ad_archive_id
  `);
  const deleteStmt = db.prepare('DELETE FROM anuncios WHERE ad_archive_id = ?');

  const tx = db.transaction((registros) => {
    for (const row of registros) {
      if (row.tipo === 'whatsapp') {
        mantidosWhatsapp++;
        continue;
      }
      const classif = classificarLink(row.link_url, row.texto);
      if (classif.tipo === 'descartar') {
        deleteStmt.run(row.ad_archive_id);
        removidos++;
      } else {
        updateStmt.run({
          ad_archive_id: row.ad_archive_id,
          link_url: classif.linkLimpo,
          tipo: classif.tipo,
          whatsapp: classif.whatsapp,
        });
        if (classif.tipo === 'pagina') mantidosPagina++;
        if (classif.tipo === 'whatsapp') mantidosWhatsapp++;
      }
    }
  });

  tx(todos);
  return { mantidosPagina, mantidosWhatsapp, removidos };
}

reclassificarBancoExistente();

const insertStmt = db.prepare(`
  INSERT INTO anuncios (
    ad_archive_id,
    page_id,
    page_name,
    start_date,
    dias_rodando,
    collation_count,
    link_url,
    tipo,
    whatsapp,
    texto,
    palavra_chave,
    data_coleta,
    tipo_oferta,
    preco_min,
    preco_max,
    checkout,
    motivo_filtro,
    video_url,
    thumb_url,
    imagem_url
  ) VALUES (
    @ad_archive_id,
    @page_id,
    @page_name,
    @start_date,
    @dias_rodando,
    @collation_count,
    @link_url,
    @tipo,
    @whatsapp,
    @texto,
    @palavra_chave,
    @data_coleta,
    @tipo_oferta,
    @preco_min,
    @preco_max,
    @checkout,
    @motivo_filtro,
    @video_url,
    @thumb_url,
    @imagem_url
  )
  ON CONFLICT(ad_archive_id) DO UPDATE SET
    page_id = excluded.page_id,
    page_name = excluded.page_name,
    start_date = excluded.start_date,
    dias_rodando = excluded.dias_rodando,
    collation_count = excluded.collation_count,
    link_url = excluded.link_url,
    tipo = excluded.tipo,
    whatsapp = excluded.whatsapp,
    texto = excluded.texto,
    palavra_chave = COALESCE(excluded.palavra_chave, anuncios.palavra_chave),
    data_coleta = excluded.data_coleta,
    tipo_oferta = COALESCE(anuncios.tipo_oferta, excluded.tipo_oferta),
    preco_min = COALESCE(anuncios.preco_min, excluded.preco_min),
    preco_max = COALESCE(anuncios.preco_max, excluded.preco_max),
    checkout = COALESCE(anuncios.checkout, excluded.checkout),
    motivo_filtro = COALESCE(anuncios.motivo_filtro, excluded.motivo_filtro),
    video_url = COALESCE(excluded.video_url, anuncios.video_url),
    thumb_url = COALESCE(excluded.thumb_url, anuncios.thumb_url),
    imagem_url = COALESCE(excluded.imagem_url, anuncios.imagem_url)
`);

function salvarAnuncios(listaAnuncios) {
  const transaction = db.transaction((anuncios) => {
    let salvos = 0;
    for (const ad of anuncios) {
      if (!ad.ad_archive_id) continue;

      const isWa = ad.tipo === 'whatsapp';
      const c1 = classificarCamada1Texto(ad.texto || '');

      // Anúncios de WhatsApp ficam com tipo_oferta = 'sem_preco' (preço a conferir)
      const tipoOfertaPadrao = isWa
        ? 'sem_preco'
        : ad.tipo_oferta !== undefined
        ? ad.tipo_oferta
        : c1.tipoOfertaInicial;

      const motivoPadrao = isWa
        ? 'whatsapp: preço a conferir'
        : ad.motivo_filtro !== undefined
        ? ad.motivo_filtro
        : c1.motivoCamada1;

      insertStmt.run({
        ...ad,
        tipo: ad.tipo || 'pagina',
        whatsapp: ad.whatsapp !== undefined && ad.whatsapp !== null ? String(ad.whatsapp) : '',
        tipo_oferta: tipoOfertaPadrao,
        preco_min: ad.preco_min !== undefined ? ad.preco_min : null,
        preco_max: ad.preco_max !== undefined ? ad.preco_max : null,
        checkout: ad.checkout !== undefined ? ad.checkout : null,
        motivo_filtro: motivoPadrao,
        video_url: ad.video_url || null,
        thumb_url: ad.thumb_url || null,
        imagem_url: ad.imagem_url || null,
      });
      salvos++;
    }
    return salvos;
  });
  return transaction(listaAnuncios);
}

function atualizarClassificacaoAnunciante(pageId, dadosClassif) {
  db.prepare(`
    UPDATE anuncios
    SET tipo_oferta = @tipo_oferta,
        preco_min = @preco_min,
        preco_max = @preco_max,
        checkout = @checkout,
        motivo_filtro = @motivo_filtro
    WHERE page_id = @page_id
  `).run({
    page_id: String(pageId),
    tipo_oferta: dadosClassif.tipo_oferta || 'sem_preco',
    preco_min: dadosClassif.preco_min !== undefined ? dadosClassif.preco_min : null,
    preco_max: dadosClassif.preco_max !== undefined ? dadosClassif.preco_max : null,
    checkout: dadosClassif.checkout || null,
    motivo_filtro: dadosClassif.motivo_filtro || null,
  });
}

function obterResumo(palavraChave) {
  const whereClause = palavraChave ? 'WHERE palavra_chave = ?' : '';
  const params = palavraChave ? [palavraChave] : [];

  const totalAnuncios = db
    .prepare(`SELECT COUNT(*) as total FROM anuncios ${whereClause}`)
    .get(...params).total;

  const totalPaginas = db
    .prepare(
      `SELECT COUNT(*) as total FROM anuncios ${
        whereClause ? whereClause + " AND tipo = 'pagina'" : "WHERE tipo = 'pagina'"
      }`
    )
    .get(...params).total;

  const totalWhatsapp = db
    .prepare(
      `SELECT COUNT(*) as total FROM anuncios ${
        whereClause ? whereClause + " AND tipo = 'whatsapp'" : "WHERE tipo = 'whatsapp'"
      }`
    )
    .get(...params).total;

  const totalAnunciantes = db
    .prepare(`SELECT COUNT(DISTINCT page_id) as total FROM anuncios ${whereClause}`)
    .get(...params).total;

  const topAnunciantes = db
    .prepare(`
      SELECT 
        page_id, 
        page_name, 
        COUNT(*) as qtd_anuncios,
        SUM(COALESCE(collation_count, 1)) as total_ativos_estimados,
        MAX(dias_rodando) as max_dias_rodando
      FROM anuncios
      ${whereClause}
      GROUP BY page_id, page_name
      ORDER BY qtd_anuncios DESC, total_ativos_estimados DESC
      LIMIT 10
    `)
    .all(...params);

  return {
    totalAnuncios,
    totalPaginas,
    totalWhatsapp,
    totalAnunciantes,
    topAnunciantes,
  };
}

function listarCriativosPorPageIds() {
  const rows = db
    .prepare(`
      SELECT
        ad_archive_id,
        page_id,
        COALESCE(collation_count, 1) AS collation_count,
        dias_rodando,
        video_url,
        thumb_url,
        imagem_url
      FROM anuncios
      WHERE page_id IS NOT NULL AND page_id != ''
        AND (video_url IS NOT NULL OR thumb_url IS NOT NULL OR imagem_url IS NOT NULL)
      ORDER BY COALESCE(collation_count, 1) DESC, COALESCE(dias_rodando, 0) DESC
    `)
    .all();

  const mapa = new Map();
  for (const r of rows) {
    const pid = String(r.page_id);
    if (!mapa.has(pid)) {
      mapa.set(pid, []);
    }
    const lista = mapa.get(pid);
    const chaveMidia = r.video_url || r.imagem_url || r.thumb_url;
    if (!lista.some((item) => (item.video_url || item.imagem_url || item.thumb_url) === chaveMidia)) {
      lista.push({
        ad_archive_id: r.ad_archive_id,
        collation_count: r.collation_count,
        video_url: r.video_url || null,
        thumb_url: r.thumb_url || null,
        imagem_url: r.imagem_url || null,
      });
    }
  }
  return mapa;
}

function listarAnunciantesAgrupados() {
  const agrupados = db
    .prepare(`
      SELECT
        page_id,
        MAX(page_name) AS page_name,
        COUNT(*) AS anuncios_salvos,
        MAX(COALESCE(dias_rodando, 0)) AS max_dias_rodando,
        MAX(COALESCE(collation_count, 1)) AS maior_duplicacao,
        GROUP_CONCAT(DISTINCT palavra_chave) AS palavra_chave,
        CASE
          WHEN SUM(CASE WHEN tipo = 'pagina' THEN 1 ELSE 0 END) > 0 THEN 'pagina'
          ELSE 'whatsapp'
        END AS tipo,
        MAX(CASE WHEN tipo = 'pagina' AND link_url IS NOT NULL AND link_url != '' THEN link_url ELSE NULL END) AS link_url,
        MAX(CASE WHEN whatsapp IS NOT NULL AND whatsapp != '' THEN whatsapp ELSE NULL END) AS whatsapp,
        COALESCE(
          MAX(CASE WHEN tipo_oferta = 'low_ticket' THEN 'low_ticket' END),
          MAX(CASE WHEN tipo_oferta = 'sem_preco' THEN 'sem_preco' END),
          MAX(CASE WHEN tipo_oferta = 'caro' THEN 'caro' END),
          MAX(CASE WHEN tipo_oferta = 'loja' THEN 'loja' END),
          'sem_preco'
        ) AS tipo_oferta,
        MIN(preco_min) AS preco_min,
        MAX(preco_max) AS preco_max,
        MAX(checkout) AS checkout,
        MAX(motivo_filtro) AS motivo_filtro
      FROM anuncios
      WHERE page_id IS NOT NULL AND page_id != ''
      GROUP BY page_id
      ORDER BY anuncios_salvos DESC, maior_duplicacao DESC
    `)
    .all();

  const mapaCriativos = listarCriativosPorPageIds();

  return agrupados.map((item) => {
    const criativos = mapaCriativos.get(String(item.page_id)) || [];
    const topCriativo = criativos[0] || null;
    return {
      ...item,
      criativos,
      video_url: topCriativo ? topCriativo.video_url : null,
      thumb_url: topCriativo ? topCriativo.thumb_url : null,
      imagem_url: topCriativo ? topCriativo.imagem_url : null,
    };
  });
}

function limparBanco() {
  const info = db.prepare('DELETE FROM anuncios').run();
  return info.changes;
}

module.exports = {
  db,
  dbPath,
  dataDir,
  criativosDir,
  classificarLink,
  reclassificarBancoExistente,
  salvarAnuncios,
  atualizarClassificacaoAnunciante,
  obterResumo,
  listarAnunciantesAgrupados,
  limparBanco,
};
