import java.util.*;

public class Errors {
    static class MyException extends Exception { MyException(String m, Throwable cause) { super(m, cause); } }
    static void level3(int n) { if (n == 0) throw new IllegalArgumentException("n is zero"); }
    static void level2() throws MyException { try { level3(0); } catch (IllegalArgumentException e) { throw new MyException("wrapped", e); } }
    static int depth = 0;
    static void recurse() { depth++; recurse(); }
    public static void main(String[] args) throws Exception {
        try { level2(); } catch (MyException e) {
            System.out.println(e.getMessage() + " / cause: " + e.getCause().getMessage() + " / " + e.getCause().getClass().getName());
            System.out.println("top frame: " + e.getStackTrace()[0].getMethodName() + " line " + e.getStackTrace()[0].getLineNumber());
        }
        try { Object s = "str"; Integer i = (Integer) s; } catch (ClassCastException e) { System.out.println("CCE " + e.getMessage()); }
        try { List.of(1).add(2); } catch (UnsupportedOperationException e) { System.out.println("UOE " + e.getMessage()); }
        try { new ArrayList<Integer>().get(3); } catch (IndexOutOfBoundsException e) { System.out.println("IOOBE " + e.getMessage()); }
        try { String s = null; s.length(); } catch (NullPointerException e) { System.out.println("NPE " + e.getMessage()); }
        try { Map<String,Integer> m = new HashMap<>(); int v = m.get("x"); } catch (NullPointerException e) { System.out.println("NPE2 " + e.getMessage()); }
        try { Iterator<Integer> it = new ArrayList<>(List.of(1,2)).iterator(); List<Integer> l = new ArrayList<>(List.of(1, 2, 3)); for (Integer x : l) if (x == 2) l.remove(x); } catch (ConcurrentModificationException e) { System.out.println("CME " + e.getMessage()); }
        try { recurse(); } catch (StackOverflowError e) { System.out.println("SOE caught, depth>1000: " + (depth > 1000)); }
        try { int[] neg = new int[-1]; } catch (NegativeArraySizeException e) { System.out.println("NASE " + e.getMessage()); }
        try { Object[] objs = new String[1]; objs[0] = 1; } catch (ArrayStoreException e) { System.out.println("ASE " + e.getMessage()); }
        try (AutoCloseable r1 = () -> System.out.println("closed r1"); AutoCloseable r2 = () -> { throw new IllegalStateException("close fails"); }) {
            throw new RuntimeException("body");
        } catch (RuntimeException e) { System.out.println("twr " + e.getMessage() + " suppressed=" + e.getSuppressed().length + " " + e.getSuppressed()[0].getMessage()); }
        finally { System.out.println("finally runs"); }
        System.err.println("to stderr");
        throw new MyException("uncaught at the end", new RuntimeException("root cause"));
    }
}
