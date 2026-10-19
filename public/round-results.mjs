// A round is public only after everybody has submitted and pending scores are published.
export const isGuessPublished=(game,guess)=>['review','reveal','finished'].includes(game.phase)||guess.turn<(game.turn||1);
export function roundAnswerMarkup(history=[],escape=String){
  return history.map(h=>`<span class="seat-answer ${h.skipped?'skipped':h.correct?'correct':'incorrect'}"><small>第 ${h.turn} 轮</small><span>${h.skipped?'跳过':escape(h.guess||'未作答')}</span><b>${h.skipped?'—':h.correct?`✓ +${h.points||0}`:'×'}</b></span>`).join('');
}
