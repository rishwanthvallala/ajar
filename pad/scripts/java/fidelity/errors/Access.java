public class Access {
    static class Box { private int secret = 1; }
    int field = 2;
    public static void main(String[] args) {
        System.out.println(field);
        Math m = new Math();
        String s = "a";
        if (s == "a") System.out.println("same");
        Thread.sleep(10);
    }
}
