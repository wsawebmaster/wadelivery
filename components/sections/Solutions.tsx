import { GradientText } from '@/components/ui/GradientText'
import { Reveal } from './Reveal'

const solutions = [
  {
    icon: '&#128722;',
    title: 'Cardápio digital próprio',
    description: 'Seu cardápio online com o nome, logo e identidade da sua marca. Atualize preços e produtos na hora, sem precisar de ninguém.',
  },
  {
    icon: '&#128674;',
    title: 'Rastreamento em tempo real',
    description: 'O cliente acompanha o status do pedido pelo celular e você acompanha tudo no painel. Menos ligações, mais confiança.',
  },
  {
    icon: '&#128202;',
    title: 'Painel de gestão completo',
    description: 'Pedidos ao vivo, alertas de atraso, dashboard de vendas e exportação do cardápio. Você enxerga a operação inteira.',
  },
  {
    icon: '&#128205;',
    title: 'Cotação de frete por CEP',
    description: 'Frete calculado automaticamente pelo endereço e CEP do cliente. Chega de negociar entrega no olho.',
  },
  {
    icon: '&#128274;',
    title: 'Seus dados, seu controle',
    description: 'Histórico e informações dos seus clientes são seus. Sem comissão, sem taxa escondida, sem dono do seu negócio.',
  },
]

export function Solutions() {
  return (
    <section className="section section-alt" id="solucoes">
      <div className="container">
        <Reveal className="section-head">
          <span className="eyebrow">A solução</span>
          <h2>Tudo o que o seu delivery precisa, <GradientText>num só lugar</GradientText></h2>
          <p>Uma plataforma completa — do cardápio digital ao painel operacional.</p>
        </Reveal>

        <div className="features-grid">
          {solutions.map((solution, i) => (
            <Reveal key={i} delay={i * 80}>
              <article className="card feature-card">
                <span className="card-icon" dangerouslySetInnerHTML={{ __html: solution.icon }} />
                <h3>{solution.title}</h3>
                <p>{solution.description}</p>
              </article>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}
