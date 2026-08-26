interface FooterProps {
  onOpenLead: () => void
}

export function Footer({ onOpenLead }: FooterProps) {
  return (
    <footer className="footer">
      <div className="container footer-inner">
        <div className="footer-brand">
          <a href="#inicio" className="brand">
            <span className="brand-mark">&#x1F6D2;</span>
            <span className="brand-name">
              Wa<strong>Delivery</strong>
            </span>
          </a>
          <p>Plataforma de delivery para restaurantes, hamburguerias e lanchonetes que querem mandar no próprio negócio.</p>
        </div>
        <nav className="footer-links" aria-label="Links do rodapé">
          <a href="#automacao">Automação</a>
          <a href="#problemas">Problemas</a>
          <a href="#solucoes">Soluções</a>
          <a href="#comparativo">Comparativo</a>
          <a href="#como-funciona">Como funciona</a>
          <a href="#faq">FAQ</a>
        </nav>
        <button type="button" className="btn btn-primary btn-sm" onClick={onOpenLead}>
          Experimentar grátis
        </button>
      </div>
      <div className="container footer-bottom">
        <span>&#169; {new Date().getFullYear()} WaDelivery — Todos os direitos reservados.</span>
      </div>
    </footer>
  )
}
