# cdk-github-runner-switch

[Read in English](README.md)

Construct do AWS CDK para quem usa os minutos gratuitos do GitHub Actions. A pipeline roda **nas máquinas do GitHub
enquanto os minutos gratuitos durarem**. Quando eles acabam, ela **passa sozinha para máquinas EC2 Spot descartáveis
(Graviton, arm64) na sua conta AWS**. No dia 1º do mês seguinte, volta para o GitHub.

Ninguém precisa lembrar de nada, a pipeline não trava no fim do mês, e você não paga por máquina parada.

## Por que

- **O plano gratuito dá conta da maior parte do mês.** Pagar runner o tempo todo é desperdício, e ver a pipeline
  travar no dia 25 também.
- **Runner próprio costuma ficar ligado direto, ou exige muita peça.** Aqui cada job ganha uma máquina nova com um
  registro de runner de uso único (JIT), e ela é encerrada quando o job termina.
- **A chave é uma variável do repositório.** O workflow escolhe o runner com uma expressão, sem duplicar workflows
  nem passo manual.

## Como funciona

| Peça | O que faz |
|---|---|
| Webhook (Function URL da Lambda) | Confere a assinatura do GitHub. Cada job na fila que pede o rótulo da AWS ganha uma máquina: primeiro Spot, em cada tipo de máquina × sub-rede, depois sob demanda. |
| Chave (a cada 30 min) | Lê os minutos do Actions usados no mês e vira `RUNNER` para `aws` no limite (padrão: 1.900 de 2.000). Volta para `github` quando o mês vira. Ao ir para a AWS, refaz as execuções que falharam por falta de minutos. |
| Reconciliação (a cada 5 min) | Job na fila sem máquina ganha uma. Cobre aviso do GitHub que se perdeu e o teto de máquinas. Máquina que ficou sem job (o job foi cancelado ou outra máquina o pegou) é desligada depois de 5 minutos. |
| Rótulo sob demanda | Jobs com `aws-ondemand` (ex.: deploy) não usam Spot, então uma interrupção nunca corta um deploy no meio. |
| Imagem | Ubuntu 24.04 arm64 da Canonical com Docker, Node.js, Python, git, GitHub CLI, AWS CLI e o runner. O EC2 Image Builder refaz a imagem todo mês. Dá para incluir imagens de contêiner em cache e comandos extras. |
| Segurança | Sem porta de entrada, IMDSv2, disco criptografado, desligar = encerrar, limite de 2 horas para job travado. A função lança, marca e lista máquinas, e só desliga as que ela mesma lançou (condição pela etiqueta). |

## Começando

```bash
npm install cdk-github-runner-switch
```

```ts
const runners = new GitHubRunnerSwitch(stack, 'Runners', { vpc, repository: 'minha-org/meu-repo' });
```

Depois, uma vez por conta e repositório:

1. **Papel do Spot** (só se a conta nunca usou Spot):
   `aws iam create-service-linked-role --aws-service-name spot.amazonaws.com`
2. **Publique** a stack (`cdk deploy`).
3. **Gere a primeira imagem** (cerca de 30 min). Depois disso, ela é refeita sozinha:
   `aws imagebuilder start-image-pipeline-execution --image-pipeline-arn <ImagePipelineArn>`
4. **Crie o GitHub App e guarde a chave** com [`scripts/setup-github-app.sh <stack>`](scripts/setup-github-app.sh),
   no seu terminal. A chave vai direto para o Secrets Manager.
5. **Aponte os workflows para a chave:**

   ```yaml
   runs-on: ${{ vars.RUNNER == 'aws' && fromJSON('["self-hosted","linux","arm64","aws"]') || 'ubuntu-24.04-arm' }}
   ```

Para trocar à mão: `gh variable set RUNNER --body aws` (ou `github`).

As opções, os custos, a segurança e as limitações estão no [README em inglês](README.md#configuration).

## Licença

[Apache-2.0](LICENSE)
