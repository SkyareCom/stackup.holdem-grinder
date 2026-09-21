# STACKUP GRINDER — HANDOFF PARA EVOLUTION 2

Atualizado em 2026-09-21.

## Repositório e branch de continuidade
- Repositório: `SkyareCom/stackup.holdem-protrainer`
- Branch: `feat/grinder-latest-ui`
- Frontend real do projeto: `app/Trainer.jsx`
- Standalone versionado: `stackup-holdem-teste-standalone.html`

## Estado visual aprovado
- Mobile-first, fundo preto/roxo, cards glass dark.
- Cards e botões com o mesmo padrão de cor.
- Cards principais em duas colunas.
- Ícone roxo no canto superior esquerdo.
- Marca-d'água temática escura dentro dos cards.
- Título dos cards no canto inferior direito.
- Números dos cards removidos.
- Bordas normais roxas; estado selecionado/prensado em prata.
- Fonte de interface: Protest Riot 400.
- Branding/cabeçalhos: Road Rage 400.
- Cor roxa principal: `#A855F7`.
- Não usar peso 300 artificial em Protest Riot/Road Rage.

## Tela principal
Ordem:
1. CONFIGURAÇÕES | SPOTS
2. ASSISTÊNCIA IA | PERFORMANCE
3. INTEGRAÇÃO | SWOT
4. HISTÓRICO | RELATÓRIOS

## Configurações
Ordem:
1. IDIOMA
2. PERFIL
3. POSIÇÃO
4. STREET
5. STACK
6. FASE
7. ESPECIAIS
8. PROGRAMADOS
9. SUGERIDOS
10. RANGES

## Cabeçalhos internos — próxima correção pendente
Preservar integralmente estrutura, rotas, botões e conteúdo abaixo do cabeçalho.

Alterar SOMENTE o cabeçalho das páginas secundárias:
- manter `STACKUP HOLD'EM` em UMA ÚNICA LINHA;
- aumentar o tamanho de `STACKUP HOLD'EM`;
- aproximar verticalmente `STACKUP HOLD'EM`, `GRINDER` e `DECIDA COM CONSISTÊNCIA`;
- não aumentar `GRINDER`;
- não mover VOLTAR / MENU PRINCIPAL;
- não alterar cards, estruturas, textos, rotas ou lógica.

## Logotipo
O novo logotipo roxo/prata com fichas substitui o anterior em todas as telas.
A integração visual não pode exibir quadrado preto ao redor do logo.
Não alterar dimensões/estrutura do cabeçalho apenas para trocar a imagem.

## Restrições obrigatórias
- Alterações solicitadas no chat são alterações NO APP, não geração de imagem.
- Não criar imagens salvo pedido explícito.
- Não reconstruir telas.
- Não adicionar placeholders.
- Não alterar lógica, navegação, rotas ou ordem de componentes em tarefa puramente visual.
- Não fazer alterações extras além do comando.
- Renderizar em viewport mobile e validar antes de entregar.
- Preservar o Range × Range e demais regras estratégicas existentes.

## Validação do projeto
Antes de entregar mudança de código:
```bash
node --test tests/*.test.mjs
npm run build
```

## Artefato local mais recente desta conversa
`STACKUP_GRINDER_CABECALHO_INTERNO_AJUSTE_PRECISO.html`

Observação: esse artefato local resolveu a integração do logotipo sem quadrado preto, porém a tipografia do cabeçalho interno ainda precisa do ajuste descrito acima.
