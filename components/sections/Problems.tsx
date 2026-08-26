import { GradientText } from '@/components/ui/GradientText'
import { Reveal } from './Reveal'

const problems = [
  {
    icon: '&#128200;',
    title: 'Comissões que comem seu lucro',
    description: 'Cada pedido nas grandes plataformas custa 12% a 30% do valor. Em um mês de 500 pedidos, é dinheiro que você dá de graça.',
  },
  {
    icon: '&#128172;',
    title: 'Pedidos perdidos no WhatsApp',
    description: 'Cardápio no papel, preços desatualizados, pedidos confundidos e clientes esperando resposta às 23h. Caos todo dia.',
  },
  {
    icon: '&#128240;',
    title: 'Sem rastreamento de pedido',
    description: 'O cliente não sabe se o pedido saiu ou chegou. Liga dezenas de vezes, cancela por impaciência e deixa avaliação negativa.',
  },
  {
    icon: '&#128273;',
    title: 'Seus clientes não são seus',
    description: 'Você não tem os dados de quem compra. O app é deles, os dados são deles, o histórico é deles. Você apenas cozinha.',
  },
  {
    icon: '&#128421;&#65039;',
    title: 'Gestão no escuro',
    description: 'Sem painel, sem relatório: você não sabe o que vendeu hoje, o que atrasou ou qual horário concentra mais pedidos.',
  },
]

export function Problems() {
  return (
    <section className="section" id="problemas">
      <div className="container">
        <Reveal className="section-head">
          <span className="eyebrow">O problema</span>
          <h2>Depender de plataformas e WhatsApp <GradientText>sai caro</GradientText></h2>
          <p>Todo dia você perde dinheiro e clientes — e às vezes nem percebe.</p>
        </Reveal>

        <div className="problems-grid">
          {problems.map((problem, i) => (
            <Reveal key={i} delay={i * 80}>
              <article className="card problem-card">
                <span className="card-icon" dangerouslySetInnerHTML={{ __html: problem.icon }} />
                <h3>{problem.title}</h3>
                <p>{problem.description}</p>
              </article>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}
