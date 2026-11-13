// Lista de domínios/termos de marketplaces e lojas grandes que NÃO devem ser salvos.
// Você pode adicionar ou remover itens desta lista quando quiser.
const DOMINIOS_BLOQUEADOS = [
  'shein',
  'mercadolivre',
  'amazon',
  'shopee',
  'magazineluiza',
  'aliexpress',
  'temu',
];

function isLinkBloqueado(linkUrl) {
  if (!linkUrl || typeof linkUrl !== 'string') return false;
  const lower = linkUrl.toLowerCase();
  return DOMINIOS_BLOQUEADOS.some((termo) => lower.includes(termo.toLowerCase()));
}

module.exports = {
  DOMINIOS_BLOQUEADOS,
  isLinkBloqueado,
};
