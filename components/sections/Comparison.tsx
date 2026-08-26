import { GradientText } from '@/components/ui/GradientText'
import { Button } from '@/components/ui/Button'
import { Reveal } from './Reveal'

interface ComparisonProps {
  onOpenLead: () => void
}

export function Comparison({ onOpenLead }: ComparisonProps) {
  return (
    <section className="section" id="comparativo">
      <div className="container">
        <Reveal className="section-head">
          <span className="eyebrow">Comparativo</span>
          <h2>Por que empresas escolhem <GradientText>sair das plataformas</GradientText></h2>
          <p>Veja a diferença de ter o seu canal próprio.</p>
        </Reveal>

        <Reveal className="compare">
          <table className="compare-table">
            <thead>
              <tr>
                <th className="compare-void" aria-hidden="true" />
                <th className="compare-us">Nossa plataforma</th>
                <th className="compare-them">Plataformas tradicionais</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Comissão por pedido</th>
                <td><span className="ok">0%</span></td>
                <td><span className="bad">12% a 30%</span></td>
              </tr>
              <tr>
                <th scope="row">Identidade visual</th>
                <td><span className="ok">Sua marca</span></td>
                <td><span className="bad">Marca deles</span></td>
              </tr>
              <tr>
                <th scope="row">Dados dos clientes</th>
                <td><span className="ok">Seus</span></td>
                <td><span className="bad">Deles</span></td>
              </tr>
              <tr>
                <th scope="row">Pedidos em tempo real</th>
                <td><span className="ok">Sim</span></td>
                <td><span className="bad">Parcial</span></td>
              </tr>
              <tr>
                <th scope="row">Frete calculado por CEP</th>
                <td><span className="ok">Sim</span></td>
                <td><span className="bad">Nem sempre</span></td>
              </tr>
              <tr>
                <th scope="row">Preço do seu cardápio</th>
                <td><span className="ok">Você define</span></td>
                <td><span className="bad">Eles impõem</span></td>
              </tr>
            </tbody>
          </table>
        </Reveal>

        <Reveal className="compare-cta">
          <p>Comissão zero, controle total e o seu nome em destaque.</p>
          <Button size="lg" onClick={onOpenLead}>
            Quero meu delivery próprio
            <span className="btn-arrow" aria-hidden="true">&#8594;</span>
          </Button>
        </Reveal>
      </div>
    </section>
  )
}
