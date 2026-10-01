import { Laya } from "@receptron/laya";

const laya = await Laya.load();

const result = await laya.systemOne(
    { subject: "Refund not received", body: "I cancelled two weeks ago and still have no refund..." },
    {
        department: {
            type: "choice",
            instructions: "Which team should handle this ticket?",
            criteria: { billing: "payments, refunds, invoices", support: "product help and bugs", sales: "new purchases" },
        },
        urgency: {
            type: "score",
            instructions: "How urgent is this ticket?",
            criteria: ["not urgent", "somewhat urgent", "urgent", "critical"],
        },
        churn_risk: { type: "noul", instructions: "Is the customer likely to cancel or dispute?" },
    },
);

console.log("Department choice:", result.answers.department.choice);
console.log("Department probabilities:", result.answers.department.probabilities);
console.log("Urgency score:", result.answers.urgency.score);
console.log("Churn risk (NOUL P(true)):", result.answers.churn_risk.noul);
console.log("Input tokens used:", result.usage.input_tokens);

await laya.close();