import { Laya } from "@receptron/laya";

const laya = await Laya.load();

const emails = [
    {
        subject: "Project status update for Q3 roadmap",
        body: "Hi team, here is the weekly progress report on our upcoming deliverables and milestones."
    },
    {
        subject: "FLASH SALE: 50% off all items this weekend!",
        body: "Don't miss out on our biggest discounts of the season. Click here to shop now and save big."
    },
    {
        subject: "CONGRATULATIONS! You have won $10,000 CASH prize!!!",
        body: "Claim your free money right now by sending your banking details to winner@unknown-domain.xyz immediately!"
    },
    {
        subject: "Your password was successfully updated",
        body: "Security Notice: The password for your account was changed at 10:45 AM. If you did not make this change, please contact support immediately."
    }
];

console.log("--- Email Category Classifier ---\n");

for (const email of emails) {
    const result = await laya.systemOne(
        { subject: email.subject, body: email.body },
        {
            category: {
                type: "choice",
                instructions: "Which category does this email belong to?",
                criteria: {
                    Inbox: "Direct personal or work correspondence, team discussions, important direct communications",
                    Updates: "System notifications, security alerts, receipts, automated status updates, confirmation messages",
                    Promotion: "Marketing emails, newsletters, discount offers, product announcements, sales ads",
                    Spam: "Phishing attempts, scam offers, unsolicited spam, suspicious claims of winning money"
                }
            }
        }
    );

    console.log(`Subject: "${email.subject}"`);
    console.log(`Category: ${result.answers.category.choice}`);
    console.log(`Probabilities:`, result.answers.category.probabilities);
    console.log(`Tokens used: ${result.usage.input_tokens}\n`);
}

await laya.close();
