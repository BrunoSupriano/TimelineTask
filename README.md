# Shift Tracker - Documentação e Arquitetura

O **Shift Tracker** é uma ferramenta avançada de gerenciamento de tarefas focada em rastrear mudanças de contexto, interrupções e impacto de produtividade. Diferente de um To-Do list comum, ele prioriza o *porquê* das mudanças de prioridade e o tempo real gasto em cada atividade dentro do horário comercial.

---

## 1. Documentação do Projeto Atual (Frontend-only)

### Escopo e Funcionalidades
- **Gestão de Tarefas:** Criação de tarefas com títulos, prioridades (Crítica, Alta, Média, Baixa) e prazos.
- **Rastreamento de Foco:** Sistema de "Foco Único" onde apenas uma tarefa pode estar ativa por vez.
- **Registro de Contexto (Shifts):** Ao trocar de uma tarefa para outra, o sistema exige uma justificativa, documentando o motivo da mudança de contexto.
- **Gestão de Interrupções:** Botão dedicado para registrar interrupções imediatas, permitindo criar uma nova tarefa "urgente" ou alternar para uma existente com log de interrupção.
- **Cálculo de Horas Úteis:** Algoritmo que calcula o tempo gasto em cada tarefa apenas dentro da janela de trabalho (Seg-Sex, 08h às 18h).
- **Visualizações:**
    - **Board:** Visão geral das tarefas ativas, estatísticas rápidas e cronômetro em tempo real.
    - **Timeline:** Histórico cronológico de todos os eventos (trocas de foco, mudanças de prioridade, interrupções).
    - **Parecer (Report):** Relatório detalhado por tarefa mostrando o impacto sofrido (vezes pausada, tempo total, histórico de interrupções sofridas).

### Regras de Negócio
- **Horário Comercial:** O tempo é contabilizado apenas entre 08:00 e 18:00, de segunda a sexta-feira.
- **Persistência:** Atualmente utiliza `window.storage` (LocalStorage) para salvar o estado do aplicativo.
- **ID Generation:** IDs aleatórios gerados no cliente.

---

## 2. Proposta de Arquitetura (Backend)

Para escalar o projeto e permitir múltiplos usuários, persistência robusta e relatórios avançados, propõe-se a seguinte stack:

### Tecnologias
- **Backend:** Django 5.x (Python 3.12+)
- **API:** Django REST Framework (DRF)
- **Banco de Dados:** PostgreSQL 17
- **Containerização:** Docker & Docker Compose
- **Autenticação:** JWT (SimpleJWT)

### Modelo de Dados Sugerido
- **User:** Usuários do sistema.
- **Task:** ID, título, prioridade, status, data de criação, deadline, tempo total (ms), id_usuario.
- **FocusEvent:** Registra cada vez que uma tarefa entra ou sai de foco (timestamp, tipo: start/pause/complete).
- **ContextShift:** Registra a transição (task_from, task_to, motivo, timestamp, is_interruption).

### Docker Compose
Abaixo, a definição da infraestrutura:

```yaml
services:
  db:
    image: postgres:17-alpine
    container_name: shift-tracker-db
    environment:
      POSTGRES_DB: shift_db
      POSTGRES_USER: user
      POSTGRES_PASSWORD: password
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U user -d shift_db"]
      interval: 5s
      timeout: 5s
      retries: 5

  backend:
    build: .
    container_name: shift-tracker-api
    command: python manage.py runserver 0.0.0.0:8000
    volumes:
      - .:/app
    ports:
      - "8000:8000"
    environment:
      - DATABASE_URL=postgres://user:password@db:5432/shift_db
    depends_on:
      db:
        condition: service_healthy

volumes:
  postgres_data:
```

---

## 3. Análise de Escopo (Migração)
A migração para essa arquitetura permitirá:
1. **Sincronização:** Uso em múltiplos dispositivos.
2. **Relatórios Históricos:** O Django pode processar agregações complexas (ex: "tempo médio de interrupção por semana") que seriam pesadas no frontend.
3. **Segurança:** Proteção de dados por usuário.
