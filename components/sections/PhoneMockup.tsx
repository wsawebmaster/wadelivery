export function PhoneMockup() {
  return (
    <div className="phone" aria-hidden="true">
      <div className="phone-notch" />
      <div className="phone-screen">
        <div className="phone-status">
          <span>9:41</span>
          <span>&#x1F4F6; &#x1F512;</span>
        </div>
        <div className="phone-brand">
          <span className="phone-logo">&#x1F6D2;</span>
          <div>
            <strong>Burger House</strong>
            <small>Aberto agora</small>
          </div>
          <span className="phone-open">&#9679;</span>
        </div>
        <div className="phone-search">
          <span>&#128269;</span><span>Buscar no cardápio...</span>
        </div>
        <div className="phone-cats">
          <span className="chip active">Lanches</span>
          <span className="chip">Bebidas</span>
          <span className="chip">Porções</span>
          <span className="chip">Doces</span>
        </div>
        <div className="phone-products">
          <div className="phone-card">
            <span className="p-img">&#x1F354;</span>
            <span className="p-info"><strong>Smash Duplo</strong><small>Pão, carne, queijo...</small></span>
            <span className="p-price">R$ 28,90</span>
          </div>
          <div className="phone-card">
            <span className="p-img">&#x1F35F;</span>
            <span className="p-info"><strong>Batata Cheddar</strong><small>Porção 300g</small></span>
            <span className="p-price">R$ 19,90</span>
          </div>
          <div className="phone-card">
            <span className="p-img">&#x1F9C8;</span>
            <span className="p-info"><strong>Combo Família</strong><small>2 burgers + fritas</small></span>
            <span className="p-price">R$ 49,90</span>
          </div>
        </div>
        <div className="phone-cta">Adicionar ao carrinho</div>
      </div>
      <div className="phone-glow" />
    </div>
  )
}
