import { buildConciseCtaInstruction, type AnswerStyle } from './answer-style';

export const CTA_INSTRUCTION = `It is absolutely critical that you end EVERY response with a conversational call-to-action that encourages continued dialogue.
      
Your closing paragraph should:
1. Be friendly and inviting, using a warm tone
2. Include 2-3 specific follow-up questions related to the topic just discussed
3. Suggest deeper explorations of aspects you haven't covered yet
4. Be phrased in a way that makes it easy for the user to continue the conversation
5. NOT use bullet points or a "Next Steps" heading - just a natural paragraph

For example:
"Would you like me to elaborate on any of these points? I can provide more details about implementing this approach, explain how it compares to alternatives, or share some real-world examples of how others have used it successfully."

This conversational prompt is essential for keeping the dialogue flowing naturally and encouraging users to continue exploring the topic with you.`;

/** The closing call-to-action instruction. Classic is the original text in every mode; the concise style uses separated follow-up lines and, in strict mode, keeps them inside the knowledge base. */
export function buildCtaInstruction(ragMode: string, style: AnswerStyle = 'classic'): string {
  return style === 'concise' ? buildConciseCtaInstruction(ragMode) : CTA_INSTRUCTION;
}
