public class Exit {
    public static void main(String[] args) {
        Runtime.getRuntime().addShutdownHook(new Thread(() -> System.out.println("shutdown hook ran")));
        System.out.println("args " + args.length + (args.length > 0 ? " first=" + args[0] : ""));
        System.out.println("java.version=" + System.getProperty("java.version") + " vendor known=" + (System.getProperty("java.vendor") != null) + " sep=" + System.getProperty("file.separator") + System.getProperty("path.separator") + " line.separator=" + System.getProperty("line.separator").replace("\n", "\\n"));
        System.out.println("env HOME set=" + (System.getenv("HOME") != null) + " cores>=1=" + (Runtime.getRuntime().availableProcessors() >= 1) + " maxMemory>0=" + (Runtime.getRuntime().maxMemory() > 0));
        System.exit(42);
    }
}
