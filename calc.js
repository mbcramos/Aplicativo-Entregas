/*
 * Cálculos e leitura de números do App de Pesagem.
 * Arquivo independente para poder ser testado fora do navegador (node teste-calc.js).
 */
(function (raiz) {
  'use strict';

  const PENALIDADE_MAX = 4; // % — penalidade permitida: 0 a 4
  const IMPOSTO_PCT = 1.5;  // % — impostos descontados do valor bruto do parceiro

  /** Arredonda sem os erros de ponto flutuante (ex.: 2.675 -> 2.68). */
  function arred(x, casas) {
    if (!isFinite(x)) return 0;
    const y = Number(x.toFixed(8));
    if (Math.abs(y) < 1e-6) return 0;
    return Number(Math.round(Number(y + 'e' + casas)) + 'e-' + casas);
  }

  /**
   * Lê um número digitado aceitando vírgula OU ponto como separador decimal.
   * Não aceita separador de milhar nem números negativos.
   * Retorna {ok, valor, vazio, erro}.
   */
  function lerNumero(txt, maxCasas) {
    const s = String(txt === null || txt === undefined ? '' : txt).trim().replace(/\s+/g, '');
    if (s === '') return { ok: true, valor: null, vazio: true };
    if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return { ok: false, erro: 'Digite apenas números.' };
    const seps = (s.match(/[.,]/g) || []).length;
    if (seps > 1) return { ok: false, erro: 'Use só uma vírgula (ou ponto). Não use separador de milhar.' };
    const partes = s.split(/[.,]/);
    const inteiro = partes[0] || '0';
    const dec = partes[1] || '';
    if (seps === 1 && dec === '') return { ok: false, erro: 'Falta o número depois da vírgula.' };
    if (dec.length > maxCasas) {
      return {
        ok: false,
        erro: maxCasas === 0
          ? 'Use número inteiro.'
          : 'Use no máximo ' + maxCasas + (maxCasas === 1 ? ' casa decimal' : ' casas decimais') +
            '. Não use separador de milhar.',
      };
    }
    return { ok: true, valor: Number(inteiro + '.' + (dec || '0')) };
  }

  /**
   * Calcula a divisão de uma entrega.
   * e = { peso_total_kg, participacao_pct, penalidade_pct, preco_base, preco_ajustado,
   *       tem_ie ('SIM'|'NAO'|'OUTRO'), desconto_modo ('NENHUM'|'VALOR'|'MAXIMO'), desconto_informado }
   * Pesos com 1 casa decimal, valores com 2.
   * Impostos (IMPOSTO_PCT) saem do valor bruto do parceiro, antes do desconto em R$.
   */
  function calcular(e) {
    const r = {
      pct_efetivo: 0,
      peso_parte_parceiro: 0,
      peso_parceiro: 0,
      peso_nome_proprietario: 0,
      peso_nome_outro: 0,
      peso_proprietario: 0,
      valor_bruto_parceiro: 0,
      valor_imposto: 0,
      desconto_maximo: 0,
      desconto_aplicado: 0,
      valor_parceiro: 0,
      valor_proprietario: 0,
      falta_peso: false,
      erros: [],
    };
    const peso = e.peso_total_kg;
    const pen = e.penalidade_pct === null || e.penalidade_pct === undefined ? 0 : e.penalidade_pct;
    const part = e.participacao_pct;
    const base = e.preco_base;
    const ajust = e.preco_ajustado;

    if (!(base > 0)) r.erros.push('Preço base inválido na planilha.');
    if (!(ajust > 0)) r.erros.push('Preço ajustado inválido na planilha.');
    if (!(part > 0 && part <= 100)) r.erros.push('Participação do parceiro inválida na planilha.');
    if (['SIM', 'NAO', 'OUTRO'].indexOf(e.tem_ie) < 0) r.erros.push('Campo I.E. inválido na planilha.');
    if (pen < 0 || pen > PENALIDADE_MAX) r.erros.push('A penalidade deve ficar entre 0 e ' + PENALIDADE_MAX + '%.');
    else if (pen > part) r.erros.push('A penalidade não pode ser maior que a participação.');
    if (peso === null || peso === undefined || !(peso > 0)) r.falta_peso = true;
    if (r.erros.length || r.falta_peso) return r;

    r.pct_efetivo = arred(part - pen, 4);
    const parte = arred(peso * r.pct_efetivo / 100 * ajust / base, 1);
    if (parte > peso) {
      r.erros.push('A parte do parceiro ficou maior que o peso total. Confira os preços na planilha.');
      return r;
    }
    r.peso_parte_parceiro = parte;
    if (e.tem_ie === 'SIM') r.peso_parceiro = parte;
    else if (e.tem_ie === 'NAO') r.peso_nome_proprietario = parte;
    else r.peso_nome_outro = parte;
    r.peso_proprietario = arred(peso - parte, 1);

    r.valor_bruto_parceiro = arred(parte * base, 2);
    r.valor_imposto = arred(r.valor_bruto_parceiro * IMPOSTO_PCT / 100, 2);
    // desconto máximo: o que sobra depois dos impostos (o parceiro fica com R$ 0,00)
    r.desconto_maximo = arred(r.valor_bruto_parceiro - r.valor_imposto, 2);

    let desc = 0;
    if (e.desconto_modo === 'MAXIMO') desc = r.desconto_maximo;
    else if (e.desconto_modo === 'VALOR') desc = e.desconto_informado || 0;
    desc = arred(desc, 2);
    if (desc > r.desconto_maximo) {
      r.erros.push('O desconto é maior que o máximo possível.');
    }
    r.desconto_aplicado = Math.min(desc, r.desconto_maximo);
    r.valor_parceiro = arred(r.valor_bruto_parceiro - r.valor_imposto - r.desconto_aplicado, 2);
    // = peso_proprietario × preco_base + desconto, calculado pelo total para fechar no centavo
    // (valor_parceiro + valor_proprietario + valor_imposto = peso_total_kg × preco_base)
    r.valor_proprietario = arred(arred(peso * base, 2) - r.valor_parceiro - r.valor_imposto, 2);
    return r;
  }

  const api = { PENALIDADE_MAX: PENALIDADE_MAX, IMPOSTO_PCT: IMPOSTO_PCT, arred: arred, lerNumero: lerNumero, calcular: calcular };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else raiz.Calc = api;
})(typeof self !== 'undefined' ? self : this);
