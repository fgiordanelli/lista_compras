# Salvatore — Compras persistentes

Projeto pronto para **Cloudflare Pages + D1**, conectado a um repositório GitHub.

## O que fica salvo no banco

- Itens da Cozinha, Pizzaria, Bar, Vinhos e Salão
- Estoque mínimo de cada item
- Itens criados, editados e removidos no painel administrativo
- Quantidade atual preenchida por data, sem necessidade de login ou PIN
- Dados compartilhados entre celulares e computadores

O GitHub guarda o código. O D1 guarda os dados alterados no uso diário.


## Acesso

- `/`: público, sem login e sem PIN
- `/admin.html`: protegido pelo `ADMIN_TOKEN`

Qualquer pessoa que conheça o endereço principal poderá alterar as quantidades do dia.

## Endereços

- Aplicativo da equipe: `/`
- Painel administrativo: `/admin.html`

## Deploy pelo GitHub e Cloudflare

### 1. Criar o repositório

Crie um repositório no GitHub, por exemplo:

`salvatore-compras`

Envie todo o conteúdo desta pasta para a raiz do repositório.

Pelo terminal:

```bash
git init
git add .
git commit -m "Aplicativo de compras do Salvatore"
git branch -M main
git remote add origin URL_DO_REPOSITORIO
git push -u origin main
```

### 2. Criar o banco D1

No painel Cloudflare:

1. Acesse **Storage & Databases**
2. Abra **D1 SQL Database**
3. Crie um banco chamado `salvatore-compras`

Não é necessário executar SQL manualmente. O aplicativo cria as tabelas e inclui os itens iniciais no primeiro acesso.

### 3. Criar o projeto Pages

No painel Cloudflare:

1. Abra **Workers & Pages**
2. Escolha **Create application**
3. Selecione **Pages**
4. Conecte o repositório do GitHub
5. Configure:
   - Framework preset: `None`
   - Build command: deixe vazio
   - Build output directory: `public`
6. Faça o primeiro deploy

### 4. Conectar o D1

No projeto Pages:

1. Abra **Settings**
2. Entre em **Bindings**
3. Adicione um binding do tipo **D1 database**
4. Variable name: `DB`
5. Escolha o banco `salvatore-compras`
6. Salve

### 5. Criar os segredos

No projeto Pages, em **Settings > Variables and Secrets**, crie:

- `ADMIN_TOKEN`: senha forte usada em `/admin.html`

Depois, faça um novo deploy em **Deployments > Retry deployment**.

## Como usar

### Equipe

1. Abra o endereço principal
2. Preencha somente os itens conferidos
3. Toque em **Calcular e enviar no WhatsApp**

### Administração

1. Abra `/admin.html`
2. Informe o `ADMIN_TOKEN`
3. Crie, edite ou remova itens
4. A mudança aparece imediatamente para todos, sem novo deploy

## Segurança

- Não coloque o `ADMIN_TOKEN` no GitHub.
- Configure-o somente como secret no painel Cloudflare.
- O painel administrativo exige o token em todas as alterações.
- O aplicativo principal é público: qualquer pessoa com o link pode preencher e salvar quantidades.


## Aba Vinhos

Esta versão inclui o setor `vinhos`.

Após o deploy:

- a aba **Vinhos** aparece na página principal;
- o painel administrativo permite criar ou mover itens para **Vinhos**;
- o item inicial **Vinhos italianos** é movido automaticamente do Bar para Vinhos;
- o banco existente é migrado automaticamente no primeiro acesso;
- itens e estoques já existentes são preservados.


## Organização de estoque aplicada

Esta versão contém **122 itens padrão**, organizados em:

- Cozinha
- Pizzaria
- Bar
- Vinhos
- Salão

A página principal exibe cabeçalhos de categoria dentro de cada aba.

### Farinhas separadas

- `Farinha para massa fresca e lasanha` — Cozinha
- `Farinha italiana tipo 00 para pizza` — Pizzaria

### Vinhos individuais

Os 19 vinhos informados foram cadastrados individualmente e divididos em:

- Tintos na carta
- Tintos fora da carta
- Brancos
- Rosés

O estoque mínimo inicial dos vinhos foi definido como 2 garrafas, exceto o Brunello
di Montalcino, definido como 1 garrafa. Esses mínimos podem ser alterados no painel
administrativo.

### Migração

O primeiro acesso após o deploy:

- renomeia itens antigos sem perder o histórico diário;
- remove itens padrão obsoletos;
- insere os novos itens;
- preserva itens personalizados criados pelo administrador;
- não exige apagar ou recriar o banco D1.


## Subabas de categorias

Cada setor possui agora subabas dinâmicas.

Exemplo na Cozinha:

- Hortifruti
- Carnes e pescados
- Queijos e laticínios
- Massas, grãos e secos
- Molhos, temperos e bebidas culinárias
- Sobremesas
- Embalagens e operação

As subabas são geradas a partir do campo `category` dos itens cadastrados no D1.
Portanto:

- ao criar um item em uma categoria existente, ele aparece nessa subaba;
- ao criar um item com uma categoria nova, uma nova subaba aparece automaticamente;
- ao remover o último item de uma categoria, a subaba desaparece;
- não é necessário novo deploy para criar uma nova subcategoria pelo painel administrativo.

A pesquisa procura em todas as subcategorias do setor selecionado.


## Coluna de custo

Foi adicionada a coluna persistente `unit_cost` no D1.

- O custo é cadastrado ou alterado somente no painel `/admin.html`.
- A página principal exibe o custo como leitura.
- O cálculo usa: `quantidade a comprar × custo unitário`.
- O WhatsApp mostra o custo estimado de cada item e o total.
- Itens sem custo continuam funcionando, mas não entram na soma estimada.
- A migração cria a coluna automaticamente, sem apagar itens ou históricos.

## Celular e tablet

A interface agora é responsiva:

- celular: itens em cards de duas colunas;
- tablet: nome do item em uma linha e dados em quatro colunas abaixo;
- abas principais e subcategorias com rolagem horizontal;
- campos e botões maiores para toque;
- painel administrativo em cards no celular.


## Correção do custo unitário

Esta versão corrige a atualização do custo:

- aceita `12,50`, `12.50`, `R$ 12,50` e valores com separador de milhar;
- rejeita custo inválido em vez de apagar silenciosamente;
- retorna ao painel o valor realmente gravado no D1;
- mostra uma confirmação como `custo R$ 12,50`;
- força a recarga sem cache no painel e no aplicativo principal.


## Persistência de preços v3

Os preços são armazenados no D1 como centavos inteiros:

- R$ 12,50 → `1250`
- R$ 100,00 → `10000`

Isso elimina erros de ponto flutuante e de formatação com vírgula.

O painel agora bloqueia a confirmação quando:

- somente a pasta `public` foi atualizada;
- a função `/api/admin` ainda é de uma versão antiga;
- o valor retornado pelo D1 é diferente do valor digitado;
- a listagem não consegue recuperar o preço salvo.

É obrigatório substituir no GitHub as duas pastas:

- `public`
- `functions`


## Correção preço v4

A versão anterior gerava um falso erro quando:

1. o POST salvava o preço e o lia corretamente no D1;
2. uma nova requisição de listagem, feita imediatamente depois, ainda retornava o valor anterior.

Na versão v4:

- a resposta confirmada do D1 atualiza a tabela imediatamente;
- IDs são comparados numericamente;
- os preços são comparados em centavos inteiros;
- a listagem é sincronizada novamente com tentativas progressivas;
- uma leitura atrasada não é mais apresentada como falha de gravação.
