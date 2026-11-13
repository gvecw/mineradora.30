const { chromium } = require('playwright');

// CAMADA 1: Palavras-chave no texto do anúncio
const TERMOS_INFOPRODUTO = [
  'pdf',
  'digital',
  'ebook',
  'e-book',
  'apostila',
  'curso',
  'acesso',
  'vitalício',
  'vitalicio',
  'imprimível',
  'imprimivel',
  'receba no e-mail',
  'receba no email',
  'receba no whatsapp',
  'download',
  'planilha',
  'moldes',
  'kit digital',
  'aulas',
  'método',
  'metodo',
  'guia',
];

const TERMOS_LOJA = [
  'frete',
  'entrega',
  'pronta entrega',
  'tamanho',
  'numeração',
  'numeracao',
  'cor disponível',
  'cor disponivel',
  'parcelamento em 10x',
  'parcelamento em 12x',
  '10x',
  '12x',
  'compre na loja',
  'estoque',
  'envio imediato',
  'rastreio',
  'cupom de frete',
];

function classificarCamada1Texto(texto) {
  if (!texto || typeof texto !== 'string') {
    return {
      pontosInfo: 0,
      pontosLoja: 0,
      passaCamada1: true,
      tipoOfertaInicial: null,
      motivoCamada1: null,
    };
  }

  const lower = texto.toLowerCase();
  const encontradosInfo = [];
  const encontradosLoja = [];

  for (const termo of TERMOS_INFOPRODUTO) {
    if (lower.includes(termo)) {
      encontradosInfo.push(termo);
    }
  }

  for (const termo of TERMOS_LOJA) {
    if (lower.includes(termo)) {
      encontradosLoja.push(termo);
    }
  }

  const pontosInfo = encontradosInfo.length;
  const pontosLoja = encontradosLoja.length;

  if (pontosLoja > pontosInfo) {
    return {
      pontosInfo,
      pontosLoja,
      passaCamada1: false,
      tipoOfertaInicial: 'loja',
      motivoCamada1: `loja (texto: ${encontradosLoja.slice(0, 3).join(', ')})`,
    };
  }

  return {
    pontosInfo,
    pontosLoja,
    passaCamada1: true,
    tipoOfertaInicial: null,
    motivoCamada1: null,
  };
}

// CAMADA 2: Sinais de e-commerce e checkouts de infoproduto na página (link_url)
const SINAIS_ECOMMERCE_HTML = [
  { chave: 'cdn.shopify', nome: 'shopify' },
  { chave: 'myshopify.com', nome: 'shopify' },
  { chave: 'nuvemshop', nome: 'nuvemshop' },
  { chave: 'mitiendanube', nome: 'nuvemshop' },
  { chave: 'lojaintegrada', nome: 'lojaintegrada' },
  { chave: 'tray.com.br', nome: 'tray' },
  { chave: 'traycorp', nome: 'tray' },
  { chave: 'yampi', nome: 'yampi' },
  { chave: 'vtex', nome: 'vtex' },
  { chave: 'woocommerce', nome: 'woocommerce' },
];

const SINAIS_ECOMMERCE_TEXTO = [
  { chave: 'adicionar ao carrinho', nome: 'adicionar ao carrinho' },
  { chave: 'calcular frete', nome: 'calcular frete' },
  { chave: 'calcule o frete', nome: 'calcular frete' },
  { chave: 'selecione o tamanho', nome: 'seletor de tamanho' },
  { chave: 'escolha o tamanho', nome: 'seletor de tamanho' },
  { chave: 'tabela de medidas', nome: 'seletor de tamanho' },
  { chave: 'cor disponível', nome: 'seletor de cor' },
  { chave: 'escolha a cor', nome: 'seletor de cor' },
];

const CHECKOUTS_INFOPRODUTO = [
  { padrao: 'hotmart', nome: 'Hotmart' },
  { padrao: 'kiwify', nome: 'Kiwify' },
  { padrao: 'eduzz', nome: 'Eduzz' },
  { padrao: 'sun.eduzz', nome: 'Eduzz' },
  { padrao: 'monetizze', nome: 'Monetizze' },
  { padrao: 'perfectpay', nome: 'PerfectPay' },
  { padrao: 'cakto', nome: 'Cakto' },
  { padrao: 'tilim', nome: 'Tilim' },
  { padrao: 'ggcheckout', nome: 'GGCheckout' },
  { padrao: 'ticto', nome: 'Ticto' },
  { padrao: 'lastlink', nome: 'Lastlink' },
  { padrao: 'braip', nome: 'Braip' },
  { padrao: 'kirvano', nome: 'Kirvano' },
  { padrao: 'greenn', nome: 'Greenn' },
  { padrao: 'pepper', nome: 'Pepper' },
  { padrao: 'payt', nome: 'Payt' },
  { padrao: 'pay.', nome: 'Pay' },
  { padrao: '/pay/', nome: 'Pay' },
  { padrao: 'checkout.', nome: 'Checkout' },
];

function parseValorReais(strNumero) {
  if (!strNumero) return null;
  let limpo = strNumero.trim().replace(/\s+/g, '');
  if (limpo.includes(',')) {
    limpo = limpo.replace(/\./g, '').replace(',', '.');
  }
  const val = parseFloat(limpo);
  if (isNaN(val) || val <= 0) return null;
  return val;
}

function formatarReais(val) {
  if (val === null || val === undefined || isNaN(val)) return '';
  return 'R$ ' + Number(val).toFixed(2).replace('.', ',');
}

function extrairPrecosDoTexto(textoVisivel) {
  if (!textoVisivel || typeof textoVisivel !== 'string') {
    return { precoMin: null, precoMax: null };
  }

  let texto = textoVisivel.replace(/\u00A0/g, ' ');

  // 1) Substituir construções "de R$ X por R$ Y" (ou "de R$ X por apenas R$ Y") mantendo apenas o "por R$ Y"
  const regexDePor =
    /\bde\s*R\$\s*\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?\s*por(?:\s+apenas)?\s*(R\$\s*\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?)/gi;
  texto = texto.replace(regexDePor, ' $1 ');

  // 2) Remover valores de parcelas para não confundir com o preço à vista (ex: "12x de R$ 9,70" ou "em até 10x R$ 5,00")
  const regexParcela =
    /\b\d{1,2}\s*x\s*(?:de\s*)?R\$\s*\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?/gi;
  texto = texto.replace(regexParcela, ' ');

  // 3) Extrair todos os preços em R$ restantes
  const regexPreco = /R\$\s*(\d{1,4}(?:\.\d{3})*(?:,\d{1,2})?)/gi;
  const valores = [];
  let match;

  while ((match = regexPreco.exec(texto)) !== null) {
    const val = parseValorReais(match[1]);
    // Filtra valores plausíveis de ofertas (entre R$ 2,00 e R$ 2.500,00) para evitar erros como "R$ 0,00" ou metas "fature R$ 10.000"
    if (val !== null && val >= 2 && val <= 2000) {
      valores.push(val);
    }
  }

  if (valores.length === 0) {
    return { precoMin: null, precoMax: null };
  }

  const precoMin = Math.min(...valores);
  const precoMax = Math.max(...valores);
  return { precoMin, precoMax };
}

function detectarCheckout(linksHrefs, htmlLower) {
  const todosLinks = Array.isArray(linksHrefs) ? linksHrefs.join(' ').toLowerCase() : '';
  const combinado = todosLinks + ' ' + (htmlLower || '');

  for (const chk of CHECKOUTS_INFOPRODUTO) {
    if (todosLinks.includes(chk.padrao)) {
      return chk.nome;
    }
  }

  for (const chk of CHECKOUTS_INFOPRODUTO) {
    if (chk.padrao !== 'pay.' && chk.padrao !== '/pay/' && chk.padrao !== 'checkout.') {
      if (combinado.includes(chk.padrao)) {
        return chk.nome;
      }
    }
  }

  return null;
}

function detectarSinalEcommerce(htmlLower, textoLower, temSeletorVarianteDom) {
  for (const s of SINAIS_ECOMMERCE_HTML) {
    if (htmlLower.includes(s.chave)) {
      return s.nome;
    }
  }
  for (const s of SINAIS_ECOMMERCE_TEXTO) {
    if (textoLower.includes(s.chave)) {
      return s.nome;
    }
  }
  if (temSeletorVarianteDom) {
    return 'seletor de tamanho/cor';
  }
  return null;
}

async function analisarPaginaComPlaywright(page, linkUrl) {
  if (!linkUrl || typeof linkUrl !== 'string' || linkUrl.includes('wa.me')) {
    return {
      tipo_oferta: 'sem_preco',
      preco_min: null,
      preco_max: null,
      checkout: null,
      motivo_filtro: 'sem_preco: link WhatsApp ou sem site',
    };
  }

  try {
    await page.goto(linkUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    // Aguarda um breve momento para renderizar scripts/preços dinâmicos
    await new Promise((r) => setTimeout(r, 1500));

    const dadosPagina = await page.evaluate(() => {
      // Remove elementos riscados (<del>, <s>, <strike> ou com line-through) antes de ler o texto de preços
      const clone = document.body ? document.body.cloneNode(true) : null;
      if (clone) {
        clone
          .querySelectorAll('del, s, strike, script, style, noscript')
          .forEach((el) => el.remove());
      }

      const textoVisivel = clone ? clone.innerText || '' : document.body?.innerText || '';
      const html = document.documentElement ? document.documentElement.outerHTML : '';
      const links = Array.from(document.querySelectorAll('a[href], form[action]')).map(
        (el) => el.getAttribute('href') || el.getAttribute('action') || ''
      );

      // Verifica se há select/inputs típicos de variante de tamanho/cor de roupa/calçado
      const selects = Array.from(
        document.querySelectorAll('select[name], input[name]')
      ).map((el) => (el.getAttribute('name') || '').toLowerCase());
      const temSeletorVarianteDom = selects.some(
        (n) =>
          n === 'size' ||
          n === 'tamanho' ||
          n === 'color' ||
          n === 'cor' ||
          n.includes('attribute_pa_tamanho') ||
          n.includes('attribute_pa_cor')
      );

      return {
        textoVisivel,
        html,
        links,
        temSeletorVarianteDom,
      };
    });

    const htmlLower = (dadosPagina.html || '').toLowerCase();
    const textoLower = (dadosPagina.textoVisivel || '').toLowerCase();

    const checkout = detectarCheckout(dadosPagina.links, htmlLower);
    const sinalLoja = detectarSinalEcommerce(
      htmlLower,
      textoLower,
      dadosPagina.temSeletorVarianteDom
    );

    const { precoMin, precoMax } = extrairPrecosDoTexto(dadosPagina.textoVisivel);

    // Se tiver sinal claro de e-commerce (e não tiver checkout explícito de infoproduto), marca como loja
    if (sinalLoja && !checkout) {
      return {
        tipo_oferta: 'loja',
        preco_min: precoMin,
        preco_max: precoMax,
        checkout: null,
        motivo_filtro: `loja: ${sinalLoja}`,
      };
    }

    // Se encontrou preços na página
    if (precoMin !== null) {
      if (precoMin <= 47) {
        return {
          tipo_oferta: 'low_ticket',
          preco_min: precoMin,
          preco_max: precoMax,
          checkout: checkout || null,
          motivo_filtro: `low_ticket: ${formatarReais(precoMin)}${
            checkout ? ` (${checkout})` : ''
          }`,
        };
      } else {
        return {
          tipo_oferta: 'caro',
          preco_min: precoMin,
          preco_max: precoMax,
          checkout: checkout || null,
          motivo_filtro: `caro: ${formatarReais(precoMin)}${
            checkout ? ` (${checkout})` : ''
          }`,
        };
      }
    }

    // Não achou preço (VSL ou preço só no checkout)
    return {
      tipo_oferta: 'sem_preco',
      preco_min: null,
      preco_max: null,
      checkout: checkout || null,
      motivo_filtro: `sem_preco: preço oculto / VSL${checkout ? ` (${checkout})` : ''}`,
    };
  } catch (err) {
    return {
      tipo_oferta: 'sem_preco',
      preco_min: null,
      preco_max: null,
      checkout: null,
      motivo_filtro: `sem_preco: site demorou ou bloqueou acesso`,
    };
  }
}

module.exports = {
  classificarCamada1Texto,
  analisarPaginaComPlaywright,
  formatarReais,
};
