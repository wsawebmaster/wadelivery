(function () {
  'use strict';

  var LEAD_STORAGE_KEY = 'landing_leads_v1';
  var lastFocused = null;

  /* ---------- Helpers ---------- */
  function $(selector, ctx) {
    return (ctx || document).querySelector(selector);
  }

  function $$(selector, ctx) {
    return Array.prototype.slice.call((ctx || document).querySelectorAll(selector));
  }

  function isEmailValid(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim());
  }

  function isPhoneValid(value) {
    var digits = value.replace(/\D/g, '');
    return digits.length >= 10 && digits.length <= 11;
  }

  /* ---------- Navbar scroll + menu ---------- */
  var nav = $('#nav');
  var navToggle = $('#navToggle');
  var navLinks = $('#navLinks');

  function onScroll() {
    if (window.scrollY > 10) {
      nav.classList.add('scrolled');
    } else {
      nav.classList.remove('scrolled');
    }
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  navToggle.addEventListener('click', function () {
    var open = navLinks.classList.toggle('open');
    navToggle.classList.toggle('open', open);
    navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    navToggle.setAttribute('aria-label', open ? 'Fechar menu' : 'Abrir menu');
  });

  $$('#navLinks a').forEach(function (link) {
    link.addEventListener('click', function () {
      navLinks.classList.remove('open');
      navToggle.classList.remove('open');
      navToggle.setAttribute('aria-expanded', 'false');
    });
  });

  /* ---------- Reveal on scroll ---------- */
  var revealObserver = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) {
        var delay = entry.target.getAttribute('data-reveal-delay');
        if (delay) {
          entry.target.style.setProperty('--reveal-delay', delay + 'ms');
        }
        entry.target.classList.add('visible');
        revealObserver.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });

  $$('.reveal').forEach(function (el) {
    revealObserver.observe(el);
  });

  /* ---------- Animated counters ---------- */
  var countersDone = false;
  var counterObserver = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting || countersDone) return;
      countersDone = true;

      $$('.trust-num').forEach(function (el) {
        var target = parseInt(el.getAttribute('data-count') || '0', 10);
        var duration = 900;
        var start = performance.now();

        function tick(now) {
          var progress = Math.min((now - start) / duration, 1);
          var eased = 1 - Math.pow(1 - progress, 3);
          el.textContent = Math.round(eased * target);
          if (progress < 1) requestAnimationFrame(tick);
        }

        requestAnimationFrame(tick);
      });

      counterObserver.disconnect();
    });
  }, { threshold: 0.4 });

  var trustList = $('.hero-trust');
  if (trustList) counterObserver.observe(trustList);

  /* ---------- Modal ---------- */
  var modal = $('#leadModal');
  var formView = $('#leadFormView');
  var successView = $('#leadSuccessView');

  function openModal() {
    lastFocused = document.activeElement;
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
    formView.hidden = false;
    successView.hidden = true;
    setTimeout(function () {
      var nome = $('#leadNome');
      if (nome) nome.focus();
    }, 120);
  }

  function closeModal() {
    modal.hidden = true;
    document.body.style.overflow = '';
    if (lastFocused && lastFocused.focus) lastFocused.focus();
  }

  $$('[data-open-lead]').forEach(function (btn) {
    btn.addEventListener('click', openModal);
  });

  $$('[data-close-lead]').forEach(function (el) {
    el.addEventListener('click', closeModal);
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !modal.hidden) closeModal();
  });

  /* ---------- Máscara de telefone ---------- */
  var telefone = $('#leadTelefone');
  telefone.addEventListener('input', function () {
    var digits = telefone.value.replace(/\D/g, '').slice(0, 11);
    if (digits.length <= 2) {
      telefone.value = digits;
    } else if (digits.length <= 6) {
      telefone.value = '(' + digits.slice(0, 2) + ') ' + digits.slice(2);
    } else if (digits.length <= 10) {
      telefone.value = '(' + digits.slice(0, 2) + ') ' + digits.slice(2, 6) + '-' + digits.slice(6);
    } else {
      telefone.value = '(' + digits.slice(0, 2) + ') ' + digits.slice(2, 7) + '-' + digits.slice(7);
    }
  });

  /* ---------- Validação ---------- */
  function setFieldState(input, valid) {
    input.closest('.field').classList.toggle('invalid', !valid);
  }

  function validateField(input) {
    var value = input.value.trim();
    var valid = false;

    if (input.type === 'email') {
      valid = isEmailValid(value);
    } else if (input.type === 'tel') {
      valid = isPhoneValid(value);
    } else {
      valid = value.length >= 2;
    }

    setFieldState(input, valid);
    return valid;
  }

  $$('#leadForm input').forEach(function (input) {
    input.addEventListener('blur', function () {
      if (input.value.trim()) validateField(input);
    });
    input.addEventListener('input', function () {
      if (input.closest('.field').classList.contains('invalid')) {
        validateField(input);
      }
    });
  });

  /* ---------- Envio (localStorage) ---------- */
  var form = $('#leadForm');

  form.addEventListener('submit', function (e) {
    e.preventDefault();

    var nome = $('#leadNome');
    var inputs = [nome, telefone, $('#leadEmail')];
    var allValid = true;

    inputs.forEach(function (input) {
      if (!validateField(input)) allValid = false;
    });

    if (!allValid) {
      var firstInvalid = form.querySelector('.field.invalid input');
      if (firstInvalid) firstInvalid.focus();
      return;
    }

    var lead = {
      nome: nome.value.trim(),
      telefone: telefone.value.trim(),
      email: $('#leadEmail').value.trim(),
      criadoEm: new Date().toISOString(),
      origem: 'landing_page'
    };

    var leads = [];
    try {
      var raw = localStorage.getItem(LEAD_STORAGE_KEY);
      if (raw) leads = JSON.parse(raw);
    } catch (err) {
      leads = [];
    }
    if (!Array.isArray(leads)) leads = [];
    leads.push(lead);
    localStorage.setItem(LEAD_STORAGE_KEY, JSON.stringify(leads));

    $('#successName').textContent = lead.nome.split(' ')[0];
    $('#successContact').textContent = lead.email || lead.telefone;
    form.reset();
    $$('.field.invalid', form).forEach(function (f) {
      f.classList.remove('invalid');
    });

    formView.hidden = true;
    successView.hidden = false;
  });

  /* ---------- Ano no rodapé ---------- */
  var year = $('#year');
  if (year) year.textContent = new Date().getFullYear();
})();
