import { GradientText } from '@/components/ui/GradientText'
import { Reveal } from './Reveal'

const items = [
  {
    title: 'Cardápio Digital',
    description: 'Com a sua marca, fotos e preços que você atualiza na hora.',
  },
  {
    title: 'Gestão de Pedidos em tempo real',
    description: 'Cada pedido cai no painel na hora, já organizado por status.',
  },
  {
    title: 'Impressão Automática',
    description: 'A comanda chega na impressora da cozinha sem você tocar em nada.',
  },
  {
    title: 'Pedidos diretos no WhatsApp e Painel de Acompanhamento',
    description: 'Contato direto entre você e o cliente, sem app no meio.',
  },
  {
    title: 'Relatório de Vendas',
    description: 'O que vendeu, quando vendeu e quanto faturou — sem planilha.',
  },
]

export function AllIncluded() {
  return (
    <section className="section section-alt" id="tudo-incluso">
      <div className="container">
        <Reveal className="section-head">
          <span className="eyebrow">Tudo incluso</span>
          <h2>Tudo isso faz parte do seu <GradientText>delivery</GradientText></h2>
          <p>Pedido confirmado em menos de 1 minuto, sem módulo extra e sem taxa escondida: tudo liberado desde o primeiro dia.</p>
        </Reveal>

        <Reveal className="incluso-grid">
          <ul className="incluso-grid">
            {items.map((item, i) => (
              <li key={i} className="incluso-item">
                <span className="incluso-check" aria-hidden="true">&#10003;</span>
                <div className="incluso-text">
                  <strong>{item.title}</strong>
                  <small>{item.description}</small>
                </div>
              </li>
            ))}
          </ul>
        </Reveal>

        <Reveal className="incluso-strip">
          <span>&#128176; Zero comissão por venda</span>
          <span>&#128274; Seus clientes e seus dados são seus</span>
          <span>&#9889;&#65039; Cardápio no ar em minutos</span>
        </Reveal>
      </div>
    </section>
  )
}
