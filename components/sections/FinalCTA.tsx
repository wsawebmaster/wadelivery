import { Button } from '@/components/ui/Button'
import { Reveal } from './Reveal'

interface FinalCTAProps {
  onOpenLead: () => void
}

export function FinalCTA({ onOpenLead }: FinalCTAProps) {
  return (
    <section className="section cta-final">
      <div className="container">
        <Reveal className="cta-box">
          <span className="cta-emoji" aria-hidden="true">&#127881;</span>
          <h2>Comece grátis hoje</h2>
          <p>Monte seu cardápio digital, receba seus primeiros pedidos e veja seu lucro crescer. Sem cartão de crédito, sem compromisso.</p>
          <Button size="xl" onClick={onOpenLead}>
            Experimentar gratuitamente
            <span className="btn-arrow" aria-hidden="true">&#8594;</span>
          </Button>
          <small>Cadastro em 2 minutos &#183; Suporte próximo de você</small>
        </Reveal>
      </div>
    </section>
  )
}
